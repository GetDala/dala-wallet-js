'use strict';

const EventEmitter = require('events').EventEmitter;
const Web3 = require('web3');
const ProviderEngine = require('web3-provider-engine');
const WalletSubprovider = require('web3-provider-engine/subproviders/wallet.js');
const Web3Subprovider = require('web3-provider-engine/subproviders/web3.js');
const FilterSubprovider = require('web3-provider-engine/subproviders/filters.js');
const HookedWalletEthTxSubprovider = require('web3-provider-engine/subproviders/hooked-wallet-ethtx.js');
const MicroRaiden = require('@raiden_network/microraiden').MicroRaiden;
const BigNumber = require("bignumber.js");
const ethUtil = require('ethereumjs-util');
const config = require('./config');
const request = require('request');

/**
 * The Dala Wallet SDK
 */
class DalaWallet extends EventEmitter {
    /**
     * 
     * @param {Object} options
     * @param {Web3} options.web3 - Instance of web3 to use
     * @param {string} options.rpcServer - The http url of the RPC server
     * @param {Object} options.sender - The sender
     * @param {string} options.sender.privateKey - The private key of the sender
     * @param {string} options.sender.address - The address of the sender 
     * @param {string} options.network - The network, must be one of either 'ropsten' or 'mainnet'
     * @param {boolean} options.autoTopupEnabled - Auto topup the payment channel when it runs out of funds
     * @param {string} options.autoTopupAmount - Auto topup amount - if autoTopupEnabled is true then this is required
     * @param {string} options.defaultDeposit - The default deposit amount when opening a channel
     * @param {string} options.baseUrl - The base url to use 
     * @param {string} options.apiKey - The API Key
     */
    constructor(options) {
        super();
        if (!options) throw new Error('options are required');
        let web3;
        if (!options.web3) {
            if (!options.rpcServer) throw new Error('options.rpcServer is required');
            if (!options.sender) throw new Error('options.sender is required');
            if (!options.sender.privateKey) throw new Error('options.sender.privateKey is required');
            if (!options.sender.address) throw new Error('options.sender.address is required');
            if (!ethUtil.isValidAddress(options.sender.address)) throw new Error('options.sender.address is invalid');
            if (!options.network) throw new Error('options.network is required');
            if (options.network.toLowerCase() !== 'ropsten' && options.network.toLowerCase() !== 'mainnet') throw new Error('options.network must be one of ropsten | mainnet');

            const engine = new ProviderEngine();
            engine.addProvider(new FilterSubprovider());
            engine.addProvider(new HookedWalletEthTxSubprovider({
                getAccounts: (cb) => {
                    return cb(null, [options.sender.address]);
                },
                getPrivateKey: (address, cb) => {
                    if (address === options.sender.address) {
                        return cb(null, new Buffer(options.sender.privateKey, 'hex'));
                    }
                    return cb(new Error('invalid address'));
                }
            }));
            engine.addProvider(new Web3Subprovider(new Web3.providers.HttpProvider(options.rpcServer)));
            engine.on('error', (error) => {
                this.emit('web3-engine-error', error);
            });
            engine.start();
            web3 = new Web3(engine);
        } else {
            web3 = options.web3;
        }
        this.uraiden = new MicroRaiden(
            web3,
            config[options.network].contractAddress,
            config[options.network].contractAbi,
            config[options.network].tokenAddress,
            config[options.network].tokenAbi
        );
        this.apiKey = options.apiKey;
        this.sender = options.sender.address;
        this.receiver = config[options.network].receiver;
        this.baseUrl = options.baseUrl;
        this.network = options.network;
        this.defaultDeposit = options.defaultDeposit;
        this.autoTopupEnabled = options.autoTopupEnabled;
        this.autoTopupAmount = options.autoTopupAmount;
        if (this.autoTopupEnabled && !this.autoTopupAmount) {
            throw new Error('If autoTopupEnabled == true, then autoTopupAmount must be provided');
        }
    }

    setupChannel(params) {
        console.log('calling setupChannel');
        var self = this;
        return this.uraiden.loadChannelFromBlockchain(self.sender, self.receiver).then(channel => {
            if (self.uraiden.isChannelValid(channel)) {
                return next(channel);
            }
            return self.uraiden.openChannel(self.sender, self.receiver, self.defaultDeposit).then(channel => {
                return next(channel);
            });
        }).catch(error => {
            if (error == 'Error: No channel found for this account') {
                return self.uraiden.openChannel(self.sender, self.receiver, self.defaultDeposit).then(channel => {
                    return next(channel);
                });
            }
            throw error;
        });

        function next(channel) {
            return new Promise((resolve, reject) => {
                const opts = { headers: { 'x-api-key': self.apiKey }, json: true }
                console.log(opts);
                request(`${self.baseUrl}/api/1/channels/${self.sender}/${channel.block}`, opts, (error, response, body) => {
                    if (error) return reject(error);
                    console.log(body);
                    if (response.statusCode >= 300) {
                        return reject(new Error(`${response.statusCode}: ${response.statusMessage}`));
                    }
                    const balance = new BigNumber(body.balance);
                    return self.uraiden.signNewProof({ balance }).then(proof => {
                        self.uraiden.confirmPayment(proof);
                        return resolve({ channel, proof })
                    });
                });
            });
        }
    }

    post(path, params, { channel, proof, headers }) {
        console.log('calling post');
        var self = this;
        return new Promise((resolve, reject) => {
            const method = 'POST';
            const body = JSON.stringify(params.body);
            headers = headers || {};
            headers['content-type'] = 'application/json';
            headers['Authorization'] = params.authorization;
            headers['x-api-key'] = self.apiKey;
            request(`${self.baseUrl}/${path}`, { headers, method, body }, (error, response, body) => {
                if (error) return reject(error);
                if (response.statusCode === 402) {
                    return setupChannel(params).then(({ channel, proof }) => {
                        self.uraiden.incrementBalanceAndSign(response.headers['rdn-price']).then(proof => {
                            self.uraiden.confirmPayment(proof);
                            headers = Object.assign({}, headers, {
                                'RDN-Contract-Address': config[self.network].contractAddress,
                                'RDN-Receiver-Address': self.receiver,
                                'RDN-Sender-Address': self.sender,
                                'RDN-Balance-Signature': proof.sig,
                                'RDN-Open-Block': channel.block.toString(),
                                'RDN-Balance': proof.balance.toString(),
                                'RDN-Sender-Balance': proof.balance.toString(),
                                'RDN-Price': response.headers['rdn-price']
                            });
                            return resolve(self.post.call(self, path, params, { channel, proof, headers }));
                        }).catch(error => {
                            const errorString = error.toString();
                            if (errorString.startsWith('Error: Insuficient funds:')) {
                                if (!self.autoTopupEnabled) return reject(error)
                                return self.uraiden.topUpChannel(self.autoTopupAmount).then(() => {
                                    console.log('TOPPED UP');
                                    return self.post.call(self, path, params, { channel, proof });
                                });
                            }
                            return reject(error);
                        });
                    }).catch(reject);
                } else {
                    return resolve(body);
                }
            });
        });
    }

    /**
     * Register a new user
     * 
     * @param {Object} params
     * @param {Object} params.body  The body
     * @param {string} params.body.username The username
     * @param {string} params.body.password The password
     * @param {string} params.body.phoneNumber  The phone number of the user - if provided must be in E164 format
     * @param {string} params.body.email    The email of the user
     * 
     * @returns {Promise} 
     */
    register(params) {
        var self = this;
        return self.post('v1/users', params, {});
        // return self.setupChannel(params).then(self.post.bind(self, 'v1/users', params));
    }

    /**
     * Authenticate an existing user
     * @param {Object} params
     * @param {String} params.body.username The username
     * @param {String} params.body.password The password
     * 
     * @returns {Promise}
     */
    authenticate(params) {
        var self = this;
        return self.post('v1/authentications', params, {});
        // return self.setupChannel(params).then(self.post.bind(self, 'v1/authentications', params));
    }

    /**
     * Create a wallet
     * @param {Object} params 
     * @param {string} params.authorization
     */
    createWallet(params) {
        var self = this;
        return self.post('v1/wallets', params, {});
        // return self.setupChannel(params).then(self.post.bind(self, 'v1/wallets', params));
    }

    internalTransfer(params) {
        var self = this;
        return self.post('v1/internal-transfers', params, {});
        // return self.setupChannel(params).then(self.post.bind(self, 'v1/internal-transfers', params));
    }

    externalTransfer(params) {
        var self = this;
        return self.post('v1/external-transfers', params, {});
        // return self.setupChannel(params).then(self.post.bind(self, 'v1/external-transfers', params));
    }
}

module.exports = DalaWallet;