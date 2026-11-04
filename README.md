# APIJOS RESORT: launch guide

*Home Away From Home*

This is the public website and management portal. Customers create accounts, book rooms, order food and drinks, buy pool passes and pay online. Managers run daily operations. The CEO sees the accounts and month-end profit or loss.

No technical knowledge is needed for steps 1 to 7, though you will find it easier with someone who has used GitHub before.

## What you need first

- A GitHub account (free)
- A Railway account for hosting (about US$5 a month for the Hobby plan, plus usage above that amount)
- A Paystack account for online payment (no monthly fee; check the current charge per payment on Paystack's pricing page)
- A website address, such as apijosresort.com, from any domain seller
- A Resend account for email (its free plan allows 100 emails a day and 3,000 a month)
- An Arkesel account for text messages (you buy credit; check its current price per text)

## Step 1: Put the code on GitHub

1. Create a new **private** repository on GitHub.
2. Choose "uploading an existing file" and upload everything in this folder.
3. Never upload a `.env` file or any file with passwords or keys.

## Step 2: Create the website on Railway

1. In Railway choose **New Project**, then **Deploy from GitHub repo**, and pick your repository. Railway finds the included `Dockerfile` by itself.
2. In the service, add a **Volume** and set its mount path to `/data`. **This matters: it is where all bookings and accounts are kept. Without it, a restart would erase them.**
3. Under **Networking**, generate a domain or connect your own address.
4. Under **Variables**, add these:

| Variable | Value |
|---|---|
| `APP_URL` | The exact address customers will use, with https and no slash at the end |
| `TRUST_PROXY` | `1` |
| `DATA_DIR` | `/data` |
| `RAILWAY_RUN_UID` | `0` |
| `TZ` | `Africa/Accra` |
| `INITIAL_CEO_EMAIL` | The CEO's email |
| `INITIAL_CEO_PASSWORD` | A strong temporary password of at least 10 characters |
| `INITIAL_CEO_NAME` | The CEO's name |
| `PAYSTACK_SECRET_KEY` | Leave out for now; see step 4 |

If you later move to another address, update `APP_URL` too. Sign-in is refused if it doesn't match.

## Step 3: First sign-in

1. Open your website and sign in with the CEO details.
2. Go to **My password** and change the password. Then delete `INITIAL_CEO_PASSWORD` from Railway.
3. Go to **Rates and menu**: name your hotels and bars, then add room types, rates, the menu and pool prices. Guests can't book until these exist.
4. Go to **Resort settings**: add the phone, email, address and your **cancellation and refund policy**.
5. Read the privacy notice on the website. It says what the resort does with customer details, so make sure it's true for you. To change the wording, edit `privacyTab` in `public/app.js`.
6. Go to **Accounts** and add your managers. Each gets a one-time link to send privately; it lets them choose a password and works for 24 hours.

## Step 4: Connect Paystack in test mode

1. In Paystack, go to **Settings**, then **API Keys & Webhooks**.
2. Copy the **test secret key** (it starts with `sk_test_`) into Railway as `PAYSTACK_SECRET_KEY`.
3. Set the test **webhook URL** to your website address followed by `/webhooks/paystack`.
4. Make a practice booking with **Pay now** and Paystack's test payment details. Check that:
   - the booking shows **Confirmed** and **Paid**
   - the payment appears in the **Cash book**
   - the Paystack fee appears as a cost

The "Pay now" choice is hidden until a key is set. Customers can still book and pay at the resort.

## Step 5: Go live with real money

1. Activate the business on Paystack by submitting its compliance documents. For a limited company these include the Certificate of Incorporation, Form 3 and Tax Identification Number; a sole proprietorship needs its Certificate of Registration. Check Paystack's Ghana page for the current list.
2. Replace the test key with the **live secret key** (`sk_live_`).
3. Set the **live webhook URL**, which is a separate setting from the test one.
4. Make one small real payment yourself and check it reaches the resort's account.
5. Clear your test records so they don't count in the real accounts: the CEO cancels each practice booking, then voids its payment, fee and refund entries in the **Cash book**.

**Keep the secret key private.** Anyone holding it can act on your Paystack account. If it is ever exposed, create a new one in Paystack straight away.

## Step 6: Switch on email and text messages

The website works without these. They can be added at any time, and nothing needs to be re-entered.

**Email**

1. In Resend, add and verify your website's domain by following its instructions for your domain seller.
2. Create an API key.
3. In Railway add `RESEND_API_KEY`, and `EMAIL_FROM` set to something like `APIJOS RESORT <bookings@your-domain.com>`.

**Text messages**

1. In Arkesel, request the sender name `APIJOS` (11 characters at most). **Allow about two weeks for the networks to approve it**, and ask Arkesel to confirm it is approved on MTN, Telecel and AirtelTigo.
2. Buy credit and copy your API key.
3. In Railway add `ARKESEL_API_KEY`, and `SMS_SENDER` set to your approved name.

**Check they work**

1. Sign in as CEO and go to **Accounts**. Under **Email and text messages**, send a test email and a test text to yourself. **Do this before relying on texts:** the Arkesel connection follows its published guide and has not yet been tried with a real account.
2. In **Resort settings**, add the email for new request alerts and the phone for urgent payment alerts.

**What gets sent**

| Event | Email to guest | Text to guest |
|---|---|---|
| Pay-at-resort request received | Yes | |
| Online payment received, booking confirmed | Yes | Yes |
| Desk confirms a room or pool pass | Yes | Yes |
| Order being prepared | Yes | Paid online only |
| Desk payment receipt | Yes | |
| Declined or cancelled | Yes | Yes |
| Payment needs checking | Yes | Yes |
| Reminder the day before a stay | Yes | Yes |

- Staff also get alerts: new requests by email, payment problems by email and text, and expenses awaiting approval by email to the CEO.
- Walk-in guests have no account, so they get texts only, and only when staff tick that the guest agreed.
- Customers can turn texts off under **My account**.
- These messages are about bookings only. Don't use them for advertising: promotions have their own rules on consent and sending times.
- If a provider is down, each message is retried for several hours. Failures appear under **Accounts**, usually meaning the credit has run out or a key is wrong.

## Step 7: Legal and business checks

- **Data protection:** the website stores customer names, phone numbers and emails. Ghana's Data Protection Commission requires every organisation handling personal data to register before processing it. Register the resort at dataprotection.org.gh, and take advice from a qualified person on your other duties.
- **Tax:** this system gives management accounts. It doesn't work out VAT, levies or tourism taxes, so have your accountant confirm the room and menu prices you enter already include whatever must be charged, and that the reports meet your filing needs.

## Everyday use

### Backups (please do this)

All your records live in one database on the volume.

- The CEO should go to **Accounts** and choose **Download database backup** at least once a week.
- Also switch on Railway's automatic volume backups if your plan offers them.
- Keep backups somewhere private, because they contain customer details and accounts.

To restore one, ask a technical person to replace `/data/apijos.db` with the backup file while the service is stopped.

### Refunds

Refund the money itself on the Paystack dashboard first. Then, in **Bookings and orders**, the CEO chooses **Cancel and record refund** so the accounts match. A manager can only do this for a payment the system has flagged for review. Otherwise the booking must go to the CEO.

### "Payments to check"

This panel on **Today** appears when:

- a customer paid twice
- the amount didn't match the price
- money arrived after a room had been taken

Sort it out, usually by refunding on Paystack or finding another room, and then choose **Mark as sorted**.

### Forgotten passwords

Once email is switched on, anyone can choose **Forgot your password?** when signing in. They get a link that works once and ends in 1 hour.

If someone can't reach their email, they call the desk. Staff confirm who they are, then create a one-time link under **Customer help** and send it privately.

### Updating a running website

Upload the new files to the same GitHub repository and Railway rebuilds the site. The database upgrades itself and keeps everything. Download a backup first anyway.

### Who can do what

| | Customer | Manager | CEO |
|---|---|---|---|
| Book, order, pay, see own bookings | Yes | | |
| Run bookings, cash book, stock, payroll, rates | | Yes | Yes |
| See month report | | Yes | Yes |
| Approve large expenses | | | Yes |
| Void system-posted payments, cancel paid bookings | | | Yes |
| Staff accounts, settings, backups, activity record | | | Yes |

## Known limits

- Customers can't change their email address themselves.
- A wrong email address can't be detected at sign-up, because addresses aren't verified.
- Rooms are counted by type, not by room number.
- Stock doesn't fall automatically when an order is served; staff record what was used.
- One server handles everything. That suits a single resort, but the site is briefly offline during an update or a server fault.

## For a technical helper

- Node.js 22 with no outside packages. The database is SQLite through the built-in `node:sqlite`.
- Run the tests: `npm test`
- Try it on your computer with made-up records: `npm run demo`, then `npm start`, then open http://localhost:3000. The demo prints a one-time password and refuses to run in production.
- Messages use the Resend and Arkesel HTTP APIs. They are saved in the same transaction as the booking change, then sent by a retrying queue. Password links are never stored.
- Money is stored in whole pesewas. Prices are always worked out on the server.
- A webhook is trusted only after its signature passes and Paystack's verify endpoint confirms the status, amount and currency.
