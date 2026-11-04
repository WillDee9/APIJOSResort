'use strict';
process.env.TZ = process.env.TZ || 'Africa/Accra';
const path = require('node:path');
const { createApp } = require('./app');

const production = process.env.NODE_ENV === 'production';
if (production && !String(process.env.APP_URL || '').startsWith('https://')) {
  console.error('APP_URL must be set to the https address of the website.');
  process.exit(1);
}
if (production && String(process.env.PAYSTACK_SECRET_KEY || '').startsWith('sk_test_')) {
  console.warn('Paystack is in TEST mode. No real money will be collected.');
}
const app = createApp({
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`,
  paystackKey: process.env.PAYSTACK_SECRET_KEY || '',
  paystackBase: process.env.PAYSTACK_BASE_URL,
  trustProxy: process.env.TRUST_PROXY === '1',
  email: { apiKey: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM, baseUrl: process.env.RESEND_BASE_URL },
  sms: { apiKey: process.env.ARKESEL_API_KEY, sender: process.env.SMS_SENDER, baseUrl: process.env.ARKESEL_BASE_URL },
});
app.ensureCeo({ email: process.env.INITIAL_CEO_EMAIL, password: process.env.INITIAL_CEO_PASSWORD, name: process.env.INITIAL_CEO_NAME })
  .then(() => app.server.listen(Number(process.env.PORT) || 3000, () => console.log(`APIJOS RESORT is running on port ${app.server.address().port}`)));

const stop = () => { app.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
