const express = require('express');
const paypal = require('@paypal/checkout-server-sdk');
const paypalRestSdk = require('paypal-rest-sdk');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

// PayPal configuration
const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
const environment = new paypal.core.SandboxEnvironment(clientId, clientSecret);
const client = new paypal.core.PayPalHttpClient(environment);

// Configure PayPal REST SDK
paypalRestSdk.configure({
  mode: 'sandbox', // Change to 'live' for production
  client_id: clientId,
  client_secret: clientSecret
});

// Webhook configuration
const webhookId = process.env.PAYPAL_WEBHOOK_ID;

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Define Payment Schema
const PaymentSchema = new mongoose.Schema({
  orderId: String,
  status: String,
  amount: Number,
  currency: String,
  payerId: String,
  payerEmail: String,
  createTime: Date,
  updateTime: Date
});

const Payment = mongoose.model('Payment', PaymentSchema);

// Create payment link
app.get('/create-payment-link', async (req, res) => {
  try {
    const amount = req.query.amount || '10.00';
    const currency = req.query.currency || 'USD';

    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: currency,
          value: amount
        }
      }],
      application_context: {
        return_url: 'https://example.com/success',
        cancel_url: 'https://example.com/cancel'
      }
    });

    const response = await client.execute(request);
    const approvalLink = response.result.links.find(link => link.rel === 'approve').href;

    console.log(`Payment link created for ${amount} ${currency}`);
    res.json({response});
  } catch (error) {
    console.error('Error creating payment link:', error);
    res.status(500).json({ error: 'An error occurred while creating the payment link' });
  }
});

// Function to capture payment
async function capturePayment(orderId) {
  const request = new paypal.orders.OrdersCaptureRequest(orderId);
  const response = await client.execute(request);
  console.log(`Payment captured for order ${orderId}`);
  return response;
}

// Webhook endpoint
app.post('/paypal-webhook', (req, res) => {
//   console.log("Entering webhook");
//   console.log("Headers:", JSON.stringify(req.headers, null, 2));
//   console.log("Body:", JSON.stringify(req.body, null, 2));
  
  const eventBody = req.body;
  const headers = {
    'paypal-auth-algo': req.headers['paypal-auth-algo'],
    'paypal-cert-url': req.headers['paypal-cert-url'],
    'paypal-transmission-id': req.headers['paypal-transmission-id'],
    'paypal-transmission-sig': req.headers['paypal-transmission-sig'],
    'paypal-transmission-time': req.headers['paypal-transmission-time']
  };

  console.log("Webhook ID:", webhookId);

  paypalRestSdk.notification.webhookEvent.verify(headers, eventBody, webhookId, async (error, response) => {
    if (error) {
      console.error('Error verifying webhook:', error);
      return res.status(400).send('Webhook verification failed');
    }

    // console.log("Verification response:", response);

    if (response.verification_status === 'SUCCESS') {
      console.log('Webhook verified');
      
      try {
        switch (eventBody.event_type) {
          case 'CHECKOUT.ORDER.APPROVED':
            console.log(`Order approved: ${eventBody.resource.id}`);
            try {
              const captureResponse = await capturePayment(eventBody.resource.id);
              console.log("Capture response:", captureResponse);
            } catch (captureError) {
              console.error("Error capturing payment:", captureError);
            }
            break;
          case 'PAYMENT.CAPTURE.COMPLETED':
            console.log("Received PAYMENT.CAPTURE.COMPLETED event");
            const resource = eventBody.resource;
            const payment = new Payment({
              orderId: resource.id,
              status: resource.status,
              amount: resource.amount.value,
              currency: resource.amount.currency_code,
              payerId: resource.payer ? resource.payer.payer_id : null,
              payerEmail: resource.payer ? resource.payer.email_address : null,
              createTime: new Date(resource.create_time),
              updateTime: new Date(resource.update_time)
            });
            try {
              await payment.save();
              console.log(`Payment saved to database for order ${resource.id}`);
            } catch (dbError) {
              console.error("Error saving to database:", dbError);
            }
            break;
          default:
            console.log(`Unhandled event type: ${eventBody.event_type}`);
        }
        res.sendStatus(200);
      } catch (error) {
        console.error('Error processing webhook:', error);
        res.sendStatus(500);
      }
    } else {
      console.log('Webhook verification failed');
      res.sendStatus(400);
    }
  });
});

// Endpoint to get all payments
app.get('/payments', async (req, res) => {
  try {
    const payments = await Payment.find();
    res.json(payments);
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// Basic error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});