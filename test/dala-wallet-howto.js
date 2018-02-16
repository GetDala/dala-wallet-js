console.debug = console.log;
const DalaWallet = require('../src/DalaWallet');
const faker = require('faker');
const secret = require('./secret');

const wallet = new DalaWallet({
    rpcServer:secret.rpcServer,
    sender: secret.sender,
    network:'ropsten',
    autoTopupEnabled: true,
    autoTopupAmount: 50000000000000000000,
    defaultDeposit: 50000000000000000000
});
wallet.register({
    body: {
        username: faker.internet.userName(),
        password: faker.internet.password(),
        phoneNumber: '+27123456789',
        email: faker.internet.email()
    },
    apiKey: secret.apiKey
}).then(result=>{
    console.log('result', result);
}).catch(error=>{
    console.log('error', error);
});
