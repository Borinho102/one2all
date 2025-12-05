import * as admin from "firebase-admin";
import Stripe from "stripe";
import { Request, Response } from "express";
import { onCall, CallableRequest, HttpsError, onRequest } from "firebase-functions/v2/https"; // Added onRequest to v2 imports
import config from "../../config";
import { defineSecret } from "firebase-functions/params";
import {sendNotificationToUserInternal} from "../alert";

// import { connectFirestoreEmulator } from "firebase/firestore";

// Initialize Firebase Admin
if (!admin.apps.length) {
    admin.initializeApp();
}

// FIX: Enable ignoreUndefinedProperties to prevent crashes if other optional fields are undefined
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

// if (location.hostname === "localhost") {
//     connectFirestoreEmulator(db, "localhost", 8080);
// }

// Get Stripe API key from environment
const stripeApiKey = config.stripe.apiKey || "";
const stripeSecretKey = config.stripe.secretKey || "";

const stripeWebhookSecret2 = config.stripe.webhookKey || "";
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

console.log("STRIPE", stripeApiKey, stripeSecretKey, stripeWebhookSecret2, stripeWebhookSecret);

const stripe = new Stripe(stripeSecretKey, {
    apiVersion: "2024-06-20" as any,
});

// ==================== INTERFACES ====================
interface PaymentDocument {
    payment_id: string;
    user_id: string;
    vendor_id: string;
    booking_id: string;
    amount: number;
    currency: string;
    status: "pending" | "success" | "failed" | "refunded" | "REFUNDED" | "FAILED" | "SUCCESS" | "PENDING";
    gateway: "stripe";
    transaction_id: string;
    customer_email: string;
    created_at: string;
    updated_at: string;
    metadata: {
        service_id?: string;
        [key: string]: any;
    };
}

interface CreatePaymentIntentRequest {
    bookingId: string;
    amount: number;
    currency?: string;
    email: string;
    name?: string;
}

interface CreatePaymentIntentResponse {
    clientSecret: string;
    paymentIntentId: string;
}

interface RequestRefundRequest {
    bookingId: string;
    reason: string;
    email?: string;
    name?: string;
}

interface RequestRefundResponse {
    success: boolean;
    refundId: string;
    data: any;
    amount: number;
}

// @ts-ignore
interface VendorPaymentsRequest {
    status?: string | null;
    limit?: number;
    offset?: number;
}

// @ts-ignore
interface VendorPaymentsResponse {
    payments: Array<{ id: string; [key: string]: any }>;
    total: number;
    amount: number;
}

interface UserPaymentsRequest {
    limit?: number;
    offset?: number;
}

interface UserPaymentsResponse {
    payments: Array<{
        id: string;
        [key: string]: any;
    }>;
    cursor?: string; // Next cursor for infinite loading (undefined if no more)
    hasMore: boolean;
    total: number; // Total items in this page
}

interface UserPaymentsRequest {
    cursor?: string; // Last booking ID from previous request
    pageSize?: number; // Defaults to 10
}

interface GetPaymentDetailsRequest {
    paymentId: string;
}

interface GetPaymentDetailsResponse {
    [key: string]: any;
}

async function getOrCreateCustomer(
    db: FirebaseFirestore.Firestore, // Pass DB instance
    uid: string,
    email: string,
    name: string
): Promise<string> {

    // STEP 1: Check your Firestore Database (Method 1)
    // We assume you have a 'users' collection.
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const userData = userSnap.data();

    if (userData && userData.stripeCustomerId) {
        console.log(`Found existing Stripe ID in DB for ${email}: ${userData.stripeCustomerId}`);
        return userData.stripeCustomerId;
    }

    // STEP 2: If not in DB, Search Stripe (Method 2)
    console.log(`No ID in DB, searching Stripe for ${email}...`);
    const existingCustomers = await stripe.customers.list({
        email: email,
        limit: 1,
    });

    let customerId: string;

    if (existingCustomers.data.length > 0) {
        // Customer exists in Stripe
        customerId = existingCustomers.data[0].id;
        console.log(`Found existing customer in Stripe: ${customerId}`);
    } else {
        // STEP 3: Create new Customer in Stripe
        console.log(`Creating new Stripe customer for ${email}...`);
        const newCustomer = await stripe.customers.create({
            email: email,
            name: name,
            metadata: {
                firebaseUID: uid // Good practice to link back to Firebase
            },
        });
        customerId = newCustomer.id;
    }

    // STEP 4: Save the ID back to Firestore (Crucial for Method 1 to work next time)
    // We use set with merge: true so we don't overwrite other user data
    await userRef.set({ stripeCustomerId: customerId }, { merge: true });

    return customerId;
}


// ==================== 1. CREATE PAYMENT INTENT ====================
export const createPaymentIntent = onCall(
    async (request: CallableRequest<CreatePaymentIntentRequest>): Promise<CreatePaymentIntentResponse> => {
        if (!request.auth || !request.auth.uid) {
            throw new HttpsError(
                "unauthenticated",
                "User must be authenticated"
            );
        }

        const { bookingId, amount, currency = "usd", email, name } = request.data;
        const userId = request.auth.uid;

        if (!bookingId || !amount || amount <= 0) {
            throw new HttpsError(
                "invalid-argument",
                "Invalid booking or amount"
            );
        }

        try {
            const bookingDoc = await db.collection("booking").doc(bookingId).get();
            if (!bookingDoc.exists) {
                throw new HttpsError("not-found", "Booking not found");
            }

            const booking = bookingDoc.data();
            const vendor_id = booking?.vendor_id;

            const customerId = await getOrCreateCustomer(db, userId, email, name ?? email);

            const paymentIntent = await stripe.paymentIntents.create({
                amount: Math.round(amount * 100),
                currency,
                customer: customerId,
                metadata: {
                    userId,
                    bookingId,
                    vendor_id,
                },
                description: `Payment for booking ${bookingId}`,
            });

            const timestamp = new Date().toISOString();

            // Step 1: Check if payment already exists
            const existingPaymentDoc = await db
                .collection("payments")
                .doc(paymentIntent.id)
                .get();

            const paymentData = {
                amount: amount,
                gateway: "stripe",
                success: "PENDING",
                status: "PENDING",
                timestamp: timestamp,
                intent: paymentIntent.id,
                transaction_id: paymentIntent.id,
                type: "payment",
                data: {
                    ...paymentIntent,
                    gateway: "stripe",
                    success: "PENDING",
                    timestamp: timestamp,
                    transaction_id: paymentIntent.id,
                    type: "payment",
                    booking_id: bookingId,
                    user_id: userId,
                    vendor_id: vendor_id,
                    email: email,
                    service_id: booking?.service_id,
                },
            };

            // Step 2: Update or Create payment
            if (existingPaymentDoc.exists) {
                console.log(`Payment intent already exists: ${paymentIntent.id}, updating...`);

                await db
                    .collection("payments")
                    .doc(paymentIntent.id)
                    .update({
                        ...paymentData,
                        updated_at: timestamp,
                    });
            } else {
                console.log(`Creating new payment intent: ${paymentIntent.id}`);

                await db
                    .collection("payments")
                    .doc(paymentIntent.id)
                    .create({
                        ...paymentData,
                        created_at: timestamp,
                    });
            }

            // Step 3: Update booking (not override)
            await db
                .collection("booking")
                .doc(bookingId)
                .update({
                    payment_id: paymentIntent.id,
                    status: "PAYMENT",
                    updated_at: timestamp,
                });

            return {
                clientSecret: paymentIntent.client_secret || "",
                paymentIntentId: paymentIntent.id,
            };
        } catch (error: any) {
            console.error("Payment intent creation error:", error);
            throw new HttpsError(
                "internal",
                error.message || "Failed to create payment intent"
            );
        }
    }
);

// ==================== 2. STRIPE WEBHOOK HANDLER ====================
export const stripeWebhook = onRequest(
    { secrets: [stripeWebhookSecret] },
    async (req: Request, res: Response) => {
        const sig = req.headers["stripe-signature"];
        const rawBody = (req as any).rawBody;

        // Get the actual string value of the secret
        const secretValue = stripeWebhookSecret2;
        // let secretValue = stripeWebhookSecret.value();

        console.log(`[••••••••••••••••••••••••••••••••••••••••••${stripeWebhookSecret.value()}•••••••••••••••••••••••••••••••••••••••••••••••••••••]`)
        console.log(`[••••••••••••••••••••••••••••••••••••••••••    ${stripeWebhookSecret2}   •••••••••••••••••••••••••••••••••••••••••••••••••••••]`)

        // --- DEBUGGING BLOCK START ---
        console.log("--- STRIPE WEBHOOK DEBUG START ---");

        // 1. Check if the secret is loaded
        if (!secretValue) {
            console.error("CRITICAL: Stripe Webhook Secret is missing.");
        } else {
            // Log first 5 chars to verify it's the right key (whsec_...)
            console.log(`Secret loaded: ${secretValue.substring(0, 5)}...`);
        }

        // 2. Check the Signature
        console.log(`Signature Header: ${sig ? "Present" : "Missing"}`);

        // 3. Check the Body format
        console.log(`RawBody Type: ${typeof rawBody}`);
        console.log(`RawBody is Buffer?: ${Buffer.isBuffer(rawBody)}`);

        if (rawBody) {
            console.log(`RawBody Length: ${rawBody.length}`);
        } else {
            console.error("CRITICAL: rawBody is undefined. Firebase did not preserve the body.");
        }
        // --- DEBUGGING BLOCK END ---

        if (!rawBody) {
            console.error("Missing rawBody in request");
            res.status(400).send("Missing raw request body");
            return;
        }

        if (!sig || !secretValue) {
            console.error("Missing signature or secret");
            res.status(400).send("Configuration Error");
            return;
        }

        let event;

        try {
            // Force the rawBody to be a buffer if it isn't already
            const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);

            event = stripe.webhooks.constructEvent(
                payload,
                sig,
                secretValue // Use the value string here
            );
        } catch (err: any) {
            console.error(`Webhook Signature Verification Failed.`);
            console.error(`Error Message: ${err.message}`);
            res.status(400).send(`Webhook Error: ${err.message}`);
            return;
        }

        console.log("Event received:", event.type);

        try {
            switch (event.type) {
                case "payment_intent.succeeded":
                    await handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);
                    console.log("Processing payment_intent.succeeded");
                    break;

                case "payment_intent.payment_failed":
                    await handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
                    console.log("Processing payment_intent.payment_failed");
                    break;

                case "charge.refunded":
                    await handleRefund(event.data.object as Stripe.Charge);
                    console.log("Processing charge.refunded");
                    break;

                case "charge.updated":
                    await handleCharge(event.data.object as Stripe.Charge);
                    console.log("Processing charge.updated");
                    break;

                case "refund.updated":
                    await finishRefund(event.data.object as Stripe.Refund);
                    console.log("Processing charge.refunded");
                    break;

                case "account.updated":
                    const account = event.data.object as Stripe.Account;
                    // Find the user in Firestore who has this bankId
                    const usersRef = db.collection('users');
                    const snapshot = await usersRef.where('bankId', '==', account.id).limit(1).get();

                    if (!snapshot.empty) {
                        const userDoc = snapshot.docs[0];
                        // Save the status to Firestore so you don't always have to call the API
                        await userDoc.ref.update({
                            stripe_details_submitted: account.details_submitted,
                            stripe_payouts_enabled: account.payouts_enabled,
                            stripe_charges_enabled: account.charges_enabled,
                            stripe_requirements: account.requirements?.currently_due || [],
                        });
                        console.log(`Updated KYC status for user ${userDoc.id}`);
                    }
                    break;

                default:
                    console.log(`Unhandled event type: ${event.type}`);
            }

            res.json({ received: true });
        } catch (error: any) {
            console.error("Webhook processing error:", error);
            res.status(500).json({ error: "Webhook processing failed" });
        }
    }
);

// ==================== 3. PAYMENT SUCCESS HANDLER ====================
async function handlePaymentSucceeded(paymentIntent: Stripe.PaymentIntent) {
    const paymentId = paymentIntent.id;
    const metadata = paymentIntent.metadata || {};
    const userId = metadata.userId;
    const bookingId = metadata.bookingId;
    const vendor_id = metadata.vendor_id;

    const chargeId = (paymentIntent as any).charges?.data?.[0]?.id || paymentIntent.id;

    // Step 1: Update payment document with new structure
    await db.collection("payments").doc(paymentId).update({
        amount: paymentIntent.amount / 100,
        gateway: "stripe",
        success: "SUCCESS",
        status: "PAID",
        timestamp: new Date().toISOString(),
        transaction_id: chargeId,
        type: "payment",
        charge: paymentIntent.latest_charge,
        data: {
            ...paymentIntent,
           user_id: userId,
           vendor_id: vendor_id,
           booking_id: bookingId,
           metadata: metadata, currency: paymentIntent.currency
        },
        vendor_id: vendor_id,
        updated_at: new Date().toISOString(),
    });

    // Step 2: Update booking with new field names
    await db.collection("booking").doc(bookingId).update({
        status: "PAID",
        is_paid: true,
        payment_id: paymentId,
        updated_at: new Date().toISOString(),
    });

    console.log(`Payment succeeded: ${paymentId} for booking: ${bookingId}`);
}

// ==================== 4. PAYMENT FAILED HANDLER ====================
async function handlePaymentFailed(paymentIntent: Stripe.PaymentIntent) {
    const paymentId = paymentIntent.id;
    const metadata = paymentIntent.metadata || {};
    const bookingId = metadata.bookingId;

    await db.collection("payments").doc(paymentId).update({
        status: "FAILED",
        success: "FALSE",
        updated_at: new Date().toISOString(),
    });

    await db.collection("bookings").doc(bookingId).update({
        payment_id: paymentId,
        status: "PAYMENT",
        is_paid: false,
        updated_at: new Date().toISOString(),
    });

    console.log(`Payment failed: ${paymentId}`);
}

// ==================== 5. REFUND HANDLER ====================
async function handleCharge(charge: Stripe.Charge) {
    const chargeId = charge.id;
    const paymentSnapshot = await db
        .collection("payments")
        .where("charge", "==", chargeId)
        .limit(1)
        .get();

    if (paymentSnapshot.empty) {
        console.log(`Payment not found for charge: ${chargeId}`);
        return;
    }
    const paymentDoc = paymentSnapshot.docs[0];
    await paymentDoc.ref.update({
        url: charge.receipt_url,
        updated_at: new Date().toISOString(),
    });

}

async function handleRefund(charge: Stripe.Charge) {
    const chargeId = charge.id;
    const refundAmount = charge.amount_refunded;

    const paymentSnapshot = await db
        .collection("payments")
        .where("transaction_id", "==", chargeId)
        .where("type", "==", "refund")
        .limit(1)
        .get();

    if (paymentSnapshot.empty) {
        console.log(`Payment not found for charge: ${chargeId}`);
        return;
    }

    const paymentDoc = paymentSnapshot.docs[0];
    const payment = paymentDoc.data() as PaymentDocument;

    await paymentDoc.ref.update({
        status: "REFUND",
        success: charge.status == 'succeeded' ? "SUCCESS" : "ERROR",
        amount: charge.amount / 100,
        charge: charge,
        url: charge.receipt_url,
        updated_at: new Date().toISOString(),
    });

    await db.collection("bookings").doc(payment.booking_id).update({
        refund_id: chargeId,
        updated_at: new Date().toISOString(),
    });

    console.log(`Refund processed: ${chargeId}, Amount: ${refundAmount}`);
}

async function finishRefund(paymentIntent: Stripe.Refund) {
    const chargeId = paymentIntent.id;
    const refundAmount = paymentIntent.amount;

    const paymentDoc = await db
        .collection("payments")
        .doc(chargeId)
        .get();

    const payment = paymentDoc.data() as PaymentDocument;

    await paymentDoc.ref.update({
        status: "REFUND",
        success: "SUCCESS",
        amount: paymentIntent.amount/100,
        data: paymentIntent,
        updated_at: new Date().toISOString(),
    });

    await db.collection("bookings").doc(payment.booking_id).update({
        refund_id: chargeId,
        is_paid: false,
        updated_at: new Date().toISOString(),
    });

    console.log(`Refund processed: ${chargeId}, Amount: ${refundAmount}`);
}

// ==================== 6. REFUND REQUEST FROM USER ====================
export const requestRefund = onCall(
    async (request: CallableRequest<RequestRefundRequest>): Promise<RequestRefundResponse> => {
        if (!request.auth || !request.auth.uid) {
            throw new HttpsError(
                "unauthenticated",
                "User must be authenticated"
            );
        }

        const { bookingId, reason } = request.data;
        const userId = request.auth.uid;

        try {
            // Step 1: Verify booking exists and user owns it
            const bookingDoc = await db.collection("booking").doc(bookingId).get();

            if (!bookingDoc.exists) {
                throw new HttpsError(
                    "not-found",
                    "Booking not found"
                );
            }

            const bookingData = bookingDoc.data();

            if (bookingData?.client_id !== userId) {
                throw new HttpsError(
                    "permission-denied",
                    "Unauthorized access"
                );
            }

            const refundId = bookingData?.refund_id;
            if (refundId && refundId.length > 0) {
                const refundDoc = await db
                    .collection("payments")
                    .doc(refundId)
                    .get();

                const refundData = refundDoc.data();

                // Verify payment is successful
                if (refundData?.success == "SUCCESS") {
                    throw new HttpsError(
                        "failed-precondition",
                        `Refund has already been processed`
                    );
                }
            }

            // Step 3: Get the payment ID from booking
            const paymentId = bookingData?.payment_id;
            if (!paymentId) {
                throw new HttpsError(
                    "not-found",
                    "No payment associated with booking"
                );
            }

            // Step 4: Fetch the payment document
            const paymentDoc = await db
                .collection("payments")
                .doc(paymentId)
                .get();

            if (!paymentDoc.exists) {
                throw new HttpsError(
                    "not-found",
                    "Payment record not found"
                );
            }

            const paymentData = paymentDoc.data();

            // Verify payment is successful
            if (paymentData?.success !== "SUCCESS") {
                throw new HttpsError(
                    "failed-precondition",
                    `Payment must be successful to refund. Current status: ${paymentData?.data?.success}`
                );
            }

            // Step 5: Create Stripe refund
            const refund = await stripe.refunds.create({
                payment_intent: paymentData?.transaction_id,
                metadata: {
                    bookingId,
                    userId,
                    reason,
                },
            });

            const timestamp = new Date().toISOString();

            await db
                .collection("payments")
                .doc(refund.id)
                .create({
                    amount: 0, // Refunded amount is 0
                    data: {
                        ...refund,
                        success: "PENDING",
                        type: refund.object,
                        refund_id: refund.id,
                        currency: refund.currency,
                        refund_timestamp: new Date().toISOString(),
                        refund_reason: reason,
                        transaction: refund.balance_transaction,
                    },
                    intent: refund.payment_intent,
                    charge: refund.charge,
                    transaction_id: refund.charge,
                    success: "PENDING",
                    type: refund.object,
                    timestamp: timestamp,
                    updated_at: new Date().toISOString(),
                });

            // // Step 7: Update booking refund_id and status
            await db.collection("booking").doc(bookingId).update({
                refund_id: refund.id,
                status: "REFUND",
                updated_at: new Date().toISOString(),
            });

            return {
                success: true,
                refundId: refund.id,
                data: {},
                amount: refund.amount / 100,
            };
        } catch (error: any) {
            console.error("Refund request error:", error);
            throw new HttpsError(
                "internal",
                error.message || "Failed to process refund"
            );
        }
    }
);

// ==================== 7. VENDOR GET PAYMENTS ====================
export const vendorGetPayments = onCall(
    async (request: CallableRequest<UserPaymentsRequest>): Promise<UserPaymentsResponse> => {

        if (!request.auth || !request.auth.uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const userId = request.auth.uid;
        const pageSize = request.data.pageSize || 10;
        const cursor = request.data.cursor;

        try {
            console.log(`Fetching payments via bookings for user: ${userId}`);

            // 1. Build the Booking Query (The Driver)
            let bookingsQuery = db
                .collection("booking")
                .where("vendor_id", "==", userId)
                .orderBy("created_at", "desc"); // Pagination follows booking creation time

            if (cursor) {
                const cursorDoc = await db.collection("booking").doc(cursor).get();
                if (!cursorDoc.exists) {
                    // Safety: If cursor doc is deleted, restart or throw
                    throw new HttpsError("invalid-argument", "Invalid cursor provided");
                }
                bookingsQuery = bookingsQuery.startAfter(cursorDoc);
            }

            // 2. Fetch limit + 1 to check hasMore without guessing
            const bookingsSnapshot = await bookingsQuery.limit(pageSize + 1).get();

            if (bookingsSnapshot.empty) {
                return {
                    payments: [],
                    cursor: undefined,
                    hasMore: false,
                    total: 0,
                };
            }

            // 3. Determine hasMore based on the raw booking fetch
            const hasMore = bookingsSnapshot.docs.length > pageSize;

            // 4. Slice to exactly the requested page size
            // We ignore the extra document we fetched for the hasMore check
            const bookingsDocs = bookingsSnapshot.docs.slice(0, pageSize);

            // 5. The cursor is ALWAYS the ID of the last booking in the slice
            // This ensures the next request starts exactly after this booking.
            const lastBooking = bookingsDocs[bookingsDocs.length - 1];
            const nextCursor = hasMore ? lastBooking.id : undefined;

            // 6. Extract Payment IDs from these specific bookings
            const paymentIds = new Set<string>();
            bookingsDocs.forEach(doc => {
                const data = doc.data();
                // Ensure payment_id exists and is not empty string
                if (data.payment_id && typeof data.payment_id === 'string' && data.payment_id.trim() !== "") {
                    paymentIds.add(data.payment_id.trim());
                }
            });

            // If no payments found in these bookings, return empty list but keep the cursor
            // so the frontend can load the next page of bookings.
            if (paymentIds.size === 0) {
                return {
                    payments: [],
                    cursor: nextCursor,
                    hasMore,
                    total: 0,
                };
            }

            // 7. Fetch the actual payment documents
            const paymentDocs = await Promise.all(Array.from(paymentIds).map(async (id) => {
                const doc = await db.collection("payments").doc(id).get();
                if (doc.exists) {
                    return {
                        id: doc.id,
                        // Add booking_id if needed for reference
                        ...doc.data()
                    };
                }
                return null;
            }));

            // 8. Filter nulls (in case a payment ref exists in booking but payment doc was deleted)
            // OPTIONAL: You can sort these payments by timestamp if you want,
            // but the "Page" order is dictated by the Booking 'created_at'.
            const transactions = paymentDocs.filter((t) => t !== null);

            return {
                payments: transactions,
                cursor: nextCursor,
                hasMore,
                total: transactions.length,
            };

        } catch (error: any) {
            console.error("Get user payments error:", error);
            throw new HttpsError("internal", error.message || "Failed to retrieve payments");
        }
    }
);

export const vendorGetPayouts = onCall(
    async (request: CallableRequest<UserPaymentsRequest>): Promise<UserPaymentsResponse> => {

        if (!request.auth || !request.auth.uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const userId = request.auth.uid;
        const pageSize = request.data.pageSize || 10;
        const cursor = request.data.cursor;

        try {
            console.log(`Fetching direct payments for vendor: ${userId}`);

            // 1. Query the 'payments' collection directly
            // Ensure you have an index in Firestore for: vendor_id ASC/DESC, timestamp DESC
            let paymentsQuery = db
                .collection("payments")
                .where("vendor_id", "==", userId) // Filter by vendor
                .where("type", "==", "payout") // Filter by vendor
                .orderBy("timestamp", "desc");    // Sort by newest first

            // 2. Handle Cursor (Pagination)
            if (cursor) {
                const cursorDoc = await db.collection("payments").doc(cursor).get();
                if (!cursorDoc.exists) {
                    throw new HttpsError("invalid-argument", "Invalid cursor provided");
                }
                paymentsQuery = paymentsQuery.startAfter(cursorDoc);
            }

            // 3. Fetch pageSize + 1 to check if there is a next page
            const paymentsSnapshot = await paymentsQuery.limit(pageSize + 1).get();

            if (paymentsSnapshot.empty) {
                return {
                    payments: [],
                    cursor: undefined,
                    hasMore: false,
                    total: 0,
                };
            }

            // 4. Determine if there is more data
            const hasMore = paymentsSnapshot.docs.length > pageSize;

            // 5. Slice to get exactly the requested amount
            const paymentDocs = paymentsSnapshot.docs.slice(0, pageSize);

            // 6. Map documents to data objects
            const transactions = paymentDocs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            // 7. Set the cursor to the ID of the last item returned
            const lastPayment = paymentDocs[paymentDocs.length - 1];
            const nextCursor = hasMore ? lastPayment.id : undefined;

            return {
                payments: transactions,
                cursor: nextCursor,
                hasMore,
                total: transactions.length,
            };

        } catch (error: any) {
            console.error("Get user payments error:", error);
            throw new HttpsError("internal", error.message || "Failed to retrieve payments");
        }
    }
);

// ==================== 8. GET PAYMENT DETAILS ====================
// FIX: Changed from functions.https.onCall (v1) to onCall (v2) to match syntax
export const getPaymentDetails = onCall(
    async (request: CallableRequest<GetPaymentDetailsRequest>): Promise<GetPaymentDetailsResponse> => {

        if (!request.auth || !request.auth.uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const { paymentId } = request.data;
        const userId = request.auth.uid;

        if (!paymentId || typeof paymentId !== 'string') {
            throw new HttpsError("invalid-argument", "paymentId is required");
        }

        try {
            const paymentDoc = await db.collection("payments").doc(paymentId).get();

            if (!paymentDoc.exists) {
                throw new HttpsError("not-found", "Payment not found");
            }

            const payment = paymentDoc.data() as PaymentDocument;

            // Find the booking - check both payment_id and refund_id
            const [paymentBookingSnapshot, refundBookingSnapshot] = await Promise.all([
                db.collection("booking").where("payment_id", "==", paymentId).get(),
                db.collection("booking").where("refund_id", "==", paymentId).get()
            ]);

            let bookingDoc = null;

            if (!paymentBookingSnapshot.empty) {
                bookingDoc = paymentBookingSnapshot.docs[0];
            } else if (!refundBookingSnapshot.empty) {
                bookingDoc = refundBookingSnapshot.docs[0];
            } else {
                throw new HttpsError("not-found", "Associated booking not found");
            }

            const booking = bookingDoc.data();

            // Check authorization: user must be either the client or vendor
            if (booking.client_id !== userId && booking.vendor_id !== userId) {
                throw new HttpsError(
                    "permission-denied",
                    "Unauthorized access"
                );
            }

            return {
                payment: {
                    id: paymentDoc.id,
                    ...payment,
                },
                booking: {
                    id: bookingDoc.id,
                    ...booking,
                },
            };
        } catch (error: any) {
            console.error("Get payment details error:", error);
            throw new HttpsError(
                "internal",
                error.message || "Failed to retrieve payment details"
            );
        }
    });

// ==================== 9. USER GET PAYMENTS ====================
export const userGetPayments = onCall(
    async (request: CallableRequest<UserPaymentsRequest>): Promise<UserPaymentsResponse> => {

        if (!request.auth || !request.auth.uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated");
        }

        const userId = request.auth.uid;
        const pageSize = request.data.pageSize || 10;
        const cursor = request.data.cursor;

        try {
            console.log(`Fetching payments for user: ${userId}`);

            let bookingsQuery = db
                .collection("booking")
                .where("client_id", "==", userId)
                .orderBy("created_at", "desc");

            if (cursor) {
                const cursorDoc = await db.collection("booking").doc(cursor).get();
                if (!cursorDoc.exists) {
                    throw new HttpsError("invalid-argument", "Invalid cursor provided");
                }
                bookingsQuery = bookingsQuery.startAfter(cursorDoc);
            }

            // Fetch more bookings to account for multiple transactions per booking
            const bookingsSnapshot = await bookingsQuery.limit(pageSize * 2).get();

            if (bookingsSnapshot.empty) {
                return {
                    payments: [],
                    cursor: undefined,
                    hasMore: false,
                    total: 0,
                };
            }

            const bookingsDocs = bookingsSnapshot.docs;

            // Extract payment and refund IDs
            const uniquePaymentIds = new Set<string>();
            const uniqueRefundIds = new Set<string>();

            bookingsDocs.forEach(doc => {
                const data = doc.data();
                if (data.payment_id?.trim()) {
                    uniquePaymentIds.add(data.payment_id.trim());
                }
                if (data.refund_id?.trim()) {
                    uniqueRefundIds.add(data.refund_id.trim());
                }
            });

            // Fetch payment and refund documents
            const [paymentDocs, refundDocs] = await Promise.all([
                Promise.all(Array.from(uniquePaymentIds).map(async (id) => {
                    const doc = await db.collection("payments").doc(id).get();
                    if (doc.exists) {
                        return {
                            id: doc.id,
                            type: 'payment',
                            ...doc.data()
                        };
                    }
                    return null;
                })),

                Promise.all(Array.from(uniqueRefundIds).map(async (id) => {
                    const doc = await db.collection("payments").doc(id).get();
                    if (doc.exists) {
                        return {
                            id: doc.id,
                            type: 'refund',
                            ...doc.data()
                        };
                    }
                    return null;
                }))
            ]);

            // Combine, filter, and sort by timestamp
            const allTransactions = [...paymentDocs, ...refundDocs]
                .filter((t) => t !== null)
                .sort((a, b) => {
                    const timeA = new Date((a as any).timestamp).getTime();
                    const timeB = new Date((b as any).timestamp).getTime();
                    return timeB - timeA; // Newest first
                });

            // FIXED: Limit transactions to pageSize
            const transactions = allTransactions.slice(0, pageSize);
            const hasMore = allTransactions.length > pageSize;

            // Get the cursor from the last booking we fetched
            const nextCursor = hasMore ? bookingsDocs[bookingsDocs.length - 1].id : undefined;

            return {
                payments: transactions,
                cursor: nextCursor,
                hasMore,
                total: transactions.length,
            };

        } catch (error: any) {
            console.error("Get user payments error:", error);
            throw new HttpsError("internal", error.message || "Failed to retrieve payments");
        }
    }
);








// ==================== 10. GET VENDOR STRIPE DASHBOARD LINK ====================
export const createMerchantAccount = onCall(async (request) => {
    // 1. Auth Check
    if (!request.auth) throw new HttpsError('unauthenticated', 'User must be logged in');

    const { email } = request.data;
    const userId = request.auth.uid;

    try {
        // 2. Check if user already has a stripe_account_id in Firestore
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        let accountId = userDoc.data()?.bankId;

        // 3. If account exists, check if we should just return a link instead of creating new
        if (accountId) {
            // Optional: Check if it exists in Stripe to be safe
            try {
                const account = await stripe.accounts.retrieve(accountId);
                if (account && account.details_submitted) {
                    throw new HttpsError('already-exists', 'Merchant account already set up. Use dashboard link.');
                }
            } catch (e) {
                // If ID exists in DB but not Stripe (deleted), proceed to create new
                accountId = null;
            }
        }

        // 4. Create new Express account if none exists
        if (!accountId) {
            const account = await stripe.accounts.create({
                type: 'express',
                country: 'CA',
                email: email,
                capabilities: {
                    card_payments: { requested: true },
                    transfers: { requested: true },
                },
                metadata: {
                    firebaseUID: userId // Link back to Firebase for safety
                }
            });
            accountId = account.id;

            // Save this ID to Firestore immediately
            await userRef.set({
                bankId: accountId,
                stripe_connect_status: 'pending'
            }, { merge: true });
        }

        // 5. Create an Account Link
        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: 'https://monlook.online/merchant/error.html',
            return_url: 'https://monlook.online/merchant/success.html',
            type: 'account_onboarding',
        });

        return { url: accountLink.url };

    } catch (error: any) {
        throw new HttpsError('internal', error.message);
    }
});

export const getVendorDashboardLink = onCall(async (request) => {
    // 1. Auth Check
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'User must be logged in');
    }

    const userId = request.auth.uid;

    try {
        // 2. Retrieve the user's Stripe Account ID (bankId) from Firestore
        const userDoc = await db.collection('users').doc(userId).get();
        const userData = userDoc.data();
        const accountId = userData?.bankId;

        if (!accountId) {
            throw new HttpsError(
                'failed-precondition',
                'No merchant account found. Please create an account first.'
            );
        }

        // 3. Retrieve the account status from Stripe
        const account = await stripe.accounts.retrieve(accountId);

        // 4. Logic: Determine which link to generate
        if (account.details_submitted) {
            // CASE A: They have finished onboarding (KYC submitted).
            // Generate a temporary login link to the Express Dashboard.
            const loginLink = await stripe.accounts.createLoginLink(accountId);

            return {
                url: loginLink.url,
                status: 'complete'
            };
        } else {
            // CASE B: They started but didn't finish onboarding.
            // Generate a new Account Link (Onboarding) to let them finish.
            const accountLink = await stripe.accountLinks.create({
                account: accountId,
                refresh_url: 'https://monlook.online/merchant/dashboard', // Redirect here if user clicks "back" or reloads
                return_url: 'https://monlook.online/merchant/dashboard',  // Redirect here on success
                type: 'account_onboarding',
            });

            return {
                url: accountLink.url,
                status: 'incomplete'
            };
        }

    } catch (error: any) {
        console.error("Dashboard link error:", error);
        throw new HttpsError('internal', error.message || "Failed to generate dashboard link");
    }
});


// ==================== 11. GET VENDOR KYC/ACCOUNT STATUS ====================

interface VendorKycStatusResponse {
    status: 'not_created' | 'incomplete' | 'pending_verification' | 'active' | 'restricted' | 'rejected';
    detailsSubmitted: boolean;
    payoutsEnabled: boolean;
    chargesEnabled: boolean;
    requirements: string[]; // List of missing things (e.g., "bank_account", "identity_document")
    disabledReason: string | null;
}

export const getVendorKycStatus = onCall(async (request): Promise<VendorKycStatusResponse> => {
    // 1. Auth Check
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'User must be authenticated');
    }

    const userId = request.auth.uid;

    try {
        // 2. Get Bank ID from Firestore
        const userDoc = await db.collection('users').doc(userId).get();
        const accountId = userDoc.data()?.bankId;

        if (!accountId) {
            return {
                status: 'not_created',
                detailsSubmitted: false,
                payoutsEnabled: false,
                chargesEnabled: false,
                requirements: [],
                disabledReason: null
            };
        }

        // 3. Retrieve Account from Stripe
        const account = await stripe.accounts.retrieve(accountId);

        // 4. Extract Key Data
        const detailsSubmitted = account.details_submitted;
        const payoutsEnabled = account.payouts_enabled;
        const chargesEnabled = account.charges_enabled;
        const requirements = account.requirements?.currently_due || [];
        const disabledReason = account.requirements?.disabled_reason || null;

        // 5. Determine "Friendly" Status
        let status: VendorKycStatusResponse['status'] = 'incomplete';

        if (!detailsSubmitted) {
            // User hasn't finished the onboarding form
            status = 'incomplete';
        } else if (disabledReason) {
            // Stripe rejected the account (fraud, prohibited business, etc.)
            status = 'rejected';
        } else if (requirements.length > 0) {
            // User finished form, but Stripe needs more info (ID scan, etc.)
            // If payouts are disabled, it's restricted. If just waiting, it might be pending.
            if (!payoutsEnabled) {
                status = 'restricted';
            } else {
                status = 'pending_verification';
            }
        } else if (payoutsEnabled && chargesEnabled) {
            // Everything is perfect
            status = 'active';
        } else {
            // Fallback (e.g. under review)
            status = 'pending_verification';
        }

        return {
            status,
            detailsSubmitted,
            payoutsEnabled,
            chargesEnabled,
            requirements, // Send this list to UI to show "Missing: ID Scan", etc.
            disabledReason
        };

    } catch (error: any) {
        console.error("Get KYC Status Error:", error);
        throw new HttpsError('internal', error.message || "Failed to retrieve account status");
    }
});








export const vendorStat = onCall(async (request) => {
    // 1. Auth Check
    if (!request.auth) throw new HttpsError('unauthenticated', 'User must be logged in');

    const userId = request.auth.uid;

    const [bookingSnapshot, analyticsSnapshot, paymentSnapshot] = await Promise.all([
        db.collection("booking").where('vendor_id', '==', userId).get(),
        db.collection("pageviews").where('business', '==', userId).where('type', '==', 'pageview').get(),
        db.collection("payments").where('vendor_id', '==', userId).get()
    ]);

    const payments = paymentSnapshot.docs.map(doc => doc.data());
    const payouts = payments.filter((d: any) => {
        return d.type === "payout" && d.success === 'SUCCESS' &&  d.status === 'COMPLETED';
    });

    const totalPayout = payouts.reduce((sum: number, item: any) => {
        return sum + (Number(item.amount) || 0);
    }, 0);

    // EXTRACT DATA FIRST
    // usage of .data() is crucial unless you are using a Firestore Converter
    const bookings = bookingSnapshot.docs.map(doc => doc.data());
    const now = new Date(); // Define 'now' once

    const totalRevenue = bookings.reduce((sum: number, item: any) => {
        return sum + (Number(item.total_amount) || 0);
    }, 0);

    // 1. Cancelled
    const cancelledBooking = bookings.filter((d: any) => {
        return d.status == 'CANCELED' && d.cancelled_date != null;
    });

    // 2. Pending (Admin hasn't decided yet)
    const pendingBooking = bookings.filter((d: any) => {
        // Ensure it's not cancelled
        return d.is_admin_decision === null && d.status !== 'CANCELED';
    });

    // 3. Approved
    const approvedBooking = bookings.filter((d: any) => {
        return d.is_admin_decision === true && d.decision_date !== null;
    });

    // 4. Rejected
    const rejectedBooking = bookings.filter((d: any) => {
        return d.is_admin_decision === false && d.decision_date !== null;
    });

    // 5. Complete
    const completeBooking = bookings.filter((d: any) => {
        const bookingDate = new Date(d.book_datetime);
        const isPassed = bookingDate < now;

        return (
            d.is_admin_decision === true &&
            d.decision_date !== null &&
            isPassed &&
            d.client_approved === true &&
            d.vendor_approved === true &&
            d.client_approved_timestamp !== null &&
            d.vendor_approved_timestamp !== null
        );
    });

    // 6. Today
    const todayBooking = bookings.filter((d: any) => {
        return checkDateStatus(d.book_datetime) === "TODAY";
    });

    // ==========================================
    // 2. VISITOR LOGIC (Gross vs Organic)
    // ==========================================
    const analyticsDocs = analyticsSnapshot.docs.map(doc => doc.data());

    // GROSS: Total count of documents found
    const grossCount = analyticsDocs.length;

    // ORGANIC: Count of unique user IDs
    // We map to get just the 'user' strings, then put them in a Set (which removes duplicates)
    const uniqueUsers = new Set(analyticsDocs.map((d: any) => d.user));
    const organicCount = uniqueUsers.size;


    const rsvpSnapshot = await db.collection("booking").where('vendor_id', '==', userId).where('refund_id', '==', null).get();
    const rsvpDocs = rsvpSnapshot.docs.map(doc => doc.data());
    // 1. Extract all Payment IDs from the bookings
    // We use a Set to ensure we don't fetch the same payment ID twice (if duplicates exist)
    const paymentIds = [...new Set(
        rsvpDocs
            .map((d: any) => d.payment_id)
            .filter((id: any) => id != null) // Ensure ID is not null
    )];

    // 2. Fetch all corresponding Payment documents in parallel
    // (Much faster than fetching them one by one in a loop)
    const paymentSnapshots = await Promise.all(
        paymentIds.map((id: string) => db.collection("payments").doc(id).get())
    );

    // 3. Sum the Amount based on your criteria
    const earnings = paymentSnapshots.reduce((sum: number, doc) => {
        const p: any = doc.data();

        if (!p) return sum;

        if (p.type == "payment" && p.status === 'PAID' && p.success === 'SUCCESS') {
            return sum + (Number(p.amount) || 0);
        }

        return sum;
    }, 0);


    try {
        return {
            user: userId,
            rsvp: {
                approved: approvedBooking.length,
                cancelled: cancelledBooking.length,
                rejected: rejectedBooking.length,
                pending: pendingBooking.length,
                total: bookings.length,
                complete: completeBooking.length,
                today: todayBooking.length
            },
            visitor: {
                organic: organicCount, // Unique
                gross: grossCount      // Total
            },
            payment: {
                revenue: totalRevenue,
                payout: totalPayout,
                earning: earnings,
                lost: 0,
                pending: 0,
            }
        };

    } catch (error: any) {
        throw new HttpsError('internal', error.message);
    }
});

// Helper function needed inside the scope or imported
function checkDateStatus(dateString: string) {
    if(!dateString) return "FUTURE"; // Safety check
    const inputDate = new Date(dateString);
    const today = new Date();

    inputDate.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);

    if (inputDate.getTime() === today.getTime()) {
        return "TODAY";
    } else if (inputDate < today) {
        return "PAST";
    } else {
        return "FUTURE";
    }
}





















// ==================== 12. RELEASE FUNDS TO VENDOR (PAYOUT/TRANSFER) ====================


// export const releaseFundsToVendor = onCall(async (request: CallableRequest<ReleaseFundsRequest>) => {
//     // 1. Auth Check (Security: Only Admin or the Vendor themselves can trigger this?)
//     // Usually, this is triggered automatically via a Cron job or by Admin.
//     // For this example, let's allow the Vendor to "Claim" funds after service is done,
//     // or Admin to release it.
//
//     if (!request.auth) {
//         throw new HttpsError('unauthenticated', 'User must be logged in');
//     }
//
//     const now = new Date();
//     const threeDaysInMillis = 3 * 24 * 60 * 60 * 1000;
//     const callerId = request.auth.uid;
//
//     try {
//         const bookingRef = db.collection("booking")
//             .where("vendor_id", "==", callerId)
//             .where("is_admin_decision", "==", true)
//             .where("vendor_approved", "==", true)
//             .where("payment_id", "!=", null); // ✅ Only ONE inequality allowed here
//
//         const bookingDoc = await bookingRef.get();
//
//         // ⚠️ LOGIC FIX: Check if empty to throw "Not Found"
//         // (Your previous code threw an error if documents DID exist)
//         if (bookingDoc.empty) {
//             throw new HttpsError('not-found', 'No Payouts Available');
//         }
//
//         let payments: any = [];
//
//         for (const doc of bookingDoc.docs) {
//             const data = doc.data();
//             // 🔍 Filter the remaining conditions in JavaScript
//             // Checking if timestamps exist
//
//             const bookDate = new Date(data.book_datetime);
//             const timeDifference = now.getTime() - bookDate.getTime();
//
//             if (
//                 (data.refund_id == null || data.refund_id.length > 0) &&
//                 (data.payout_id == null || data.payout_id.length > 0) &&
//                 ((data.client_approved == true  && data.client_approved_timestamp) || (timeDifference > threeDaysInMillis)) &&
//                 data.vendor_approved_timestamp && data.decision_date
//             ) {
//                 const paymentRef = db.collection("payments").doc(data.payment_id);
//                 const paymentDoc = await paymentRef.get();
//                 if (!paymentDoc.exists) {
//                     throw new HttpsError('not-found', 'Payment not found');
//                 }
//                 const paymentData: any = paymentDoc.data();
//                 if(
//                     paymentData.status.toString().toUpperCase() == "PAID" &&
//                     paymentData.success.toString().toUpperCase() == "SUCCESS" &&
//                     paymentData.payout_id == null){
//                     payments.push(paymentData);
//                 }
//             }
//         }
//
//         // 5. Get Vendor's Stripe Account ID (Connect ID)
//         const vendorUserDoc = await db.collection("users").doc(callerId).get();
//         const vendorStripeId = vendorUserDoc.data()?.bankId;
//
//         if (!vendorStripeId) {
//             throw new HttpsError('failed-precondition', 'Vendor has not set up a Stripe Payout Account');
//         }
//
//         // // 6. Calculate Split (Commission)
//         // // Example: Platform keeps 10%, Vendor gets 90%
//         // const totalAmount = paymentData.amount; // e.g., 100.00
//         // const commissionRate = 0.10; // 10%
//         // const platformFee = totalAmount * commissionRate;
//         // const payoutAmount = totalAmount - platformFee;
//         //
//         // // Convert to cents for Stripe (Stripe uses integers)
//         // const transferAmountCents = Math.round(payoutAmount * 100);
//         //
//         // console.log(`Processing Transfer: Total: ${totalAmount}, Fee: ${platformFee}, Payout: ${payoutAmount} to ${vendorStripeId}`);
//         //
//         // // 7. Execute Stripe Transfer
//         // // This moves money from Your Platform Balance -> Vendor's Connected Account
//         // const transfer = await stripe.transfers.create({
//         //     amount: transferAmountCents,
//         //     currency: paymentData.currency || 'cad',
//         //     destination: vendorStripeId,
//         //     description: `Payout for Booking #${bookingId}`,
//         //     metadata: {
//         //         bookingId: bookingId,
//         //         vendorId: vendorId,
//         //         platformFee: platformFee.toString()
//         //     }
//         //     // source_transaction: paymentData.transaction_id, // OPTIONAL: Tries to link to specific incoming charge (requires charge to be valid)
//         // });
//         //
//         // // 8. Record the Transaction in Firestore
//         // const timestamp = new Date().toISOString();
//         // const payoutId = transfer.id;
//         //
//         // await db.collection("payments").doc(payoutId).create({
//         //     amount: payoutAmount,
//         //     currency: paymentData.currency,
//         //     gateway: "stripe",
//         //     success: "SUCCESS",
//         //     status: "COMPLETED",
//         //     timestamp: timestamp,
//         //     transaction_id: transfer.id,
//         //     type: "payout", // Marking this as a Payout/Transfer
//         //     vendor_id: vendorId,
//         //     booking_id: bookingId,
//         //     data: transfer,
//         //     metadata: {
//         //         commission: platformFee,
//         //         original_payment_id: paymentId
//         //     },
//         //     created_at: timestamp,
//         //     updated_at: timestamp,
//         // });
//         //
//         // // 9. Update Booking Status
//         // await bookingRef.update({
//         //     payout_id: payoutId,
//         //     payout_status: "COMPLETED",
//         //     payout_amount: payoutAmount,
//         //     updated_at: timestamp
//         // });
//         //
//         return {
//             success: true,
//             account: vendorStripeId,
//             vendor: callerId,
//             payments: payments
//             // transferId: transfer.id,
//             // amount: payoutAmount,
//             // fee: platformFee
//         };
//
//     } catch (error: any) {
//         console.error("Payout Release Error:", error);
//         throw new HttpsError('internal', error.message || "Failed to release funds");
//     }
// });


// Interface for the return object
interface PayoutResult {
    bookingId: string;
    amount: number;
    status: "SUCCESS" | "FAILED";
    error?: string;
    transferId?: string;
}

export const releaseFundsToVendor = onCall(async (request: CallableRequest<any>) => {
    // 1. Auth Check
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'User must be logged in');
    }

    const callerId = request.auth.uid;
    const now = new Date();
    const threeDaysInMillis = 3 * 24 * 60 * 60 * 1000;

    try {
        // 2. Get Vendor's Stripe Account ID first
        const vendorUserDoc = await db.collection("users").doc(callerId).get();
        const vendorStripeId = vendorUserDoc.data()?.bankId;

        if (!vendorStripeId) {
            throw new HttpsError('failed-precondition', 'Vendor has not set up a Stripe Payout Account');
        }

        // 3. Query Potential Bookings
        const bookingRef = db.collection("booking")
            .where("vendor_id", "==", callerId)
            .where("vendor_approved", "==", true)
            .where("payment_id", "!=", null); // Ensure payment exists

        const bookingSnap = await bookingRef.get();

        if (bookingSnap.empty) {
            throw new HttpsError('not-found', 'No bookings found for this vendor');
        }

        // 4. Identify Eligible Bookings & Fetch Payment Details
        // We will store promises here to run in parallel
        const eligibleItems: { booking: any; payment: any; bookingDocRef: any }[] = [];

        // Pre-fetch logic
        for (const doc of bookingSnap.docs) {
            const data = doc.data();
            const bookDate = new Date(data.book_datetime);
            const timeDifference = now.getTime() - bookDate.getTime();

            // LOGIC FIX:
            // 1. Refund ID should be null or empty string (NOT length > 0, which implies it exists)
            // 2. Payout ID should be null or empty string
            const isRefunded = data.refund_id && data.refund_id.length > 0;
            const isPaidOut = data.payout_id && data.payout_id.length > 0;

            // 3. Client Approval OR 3 Days passed
            const isAutoApproved = timeDifference > threeDaysInMillis && data.client_approved == null && data.client_approved_timestamp == null;
            const isClientApproved = data.client_approved === true;

            if (!isRefunded && !isPaidOut && (isClientApproved || isAutoApproved)) {
                // Fetch the payment document
                // Note: For high volume, it is better to do a "where-in" query, but this works for <50 items
                const paymentDoc = await db.collection("payments").doc(data.payment_id).get();

                if (paymentDoc.exists) {
                    const paymentData = paymentDoc.data() as any;

                    // Verify Payment Success
                    if (
                        paymentData.status?.toString().toUpperCase() === "PAID" &&
                        paymentData.success?.toString().toUpperCase() === "SUCCESS" &&
                        !paymentData.payout_id // Double check payment doc doesn't have payout
                    ) {
                        eligibleItems.push({
                            booking: {
                                ...data,      // Spread data first
                                id: doc.id    // This will overwrite the 'id' from data with the Firestore UID
                            },
                            bookingDocRef: doc.ref,
                            payment: {
                                id: paymentDoc.id,
                                ...paymentData
                            }
                        });
                    }
                }
            }
        }

        if (eligibleItems.length === 0) {
            return {
                success: true,
                message: "No eligible payouts found at this time.",
                results: []
            };
        }

        // 5. Process Transfers & Database Updates
        const results: PayoutResult[] = [];
        const batch = db.batch();
        let batchCount = 0; // Firestore batch limit is 500 operations

        console.log(`Processing ${eligibleItems.length} eligible payouts...`);

        // We process sequentially or via Promise.all.
        // Sequential is safer for rate limits if you have many.
        // Using Promise.all for speed here, assuming < 50 items.

        await Promise.all(eligibleItems.map(async (item) => {
            const { booking, payment, bookingDocRef } = item;

            const vendorUserDoc = await db.collection("users").doc(callerId).get();
            const vendorStripeId = vendorUserDoc.data()?.bankId;
            const vendorRate = vendorUserDoc.data()?.rate;

            console.log("FETCHED RATE:", vendorRate);

            try {
                // Calculation
                const totalAmount = parseFloat(payment.amount);
                const commissionRate = parseFloat(vendorRate ?? 10) / 100;
                const platformFee = totalAmount * commissionRate;
                const payoutAmount = totalAmount - platformFee;
                const transferAmountCents = Math.round(payoutAmount * 100);

                // Stripe Transfer
                const transfer = await stripe.transfers.create({
                    amount: transferAmountCents,
                    currency: payment.currency || 'cad',
                    destination: vendorStripeId,
                    description: `Payout for Booking #${booking.id}`,
                    metadata: {
                        bookingId: booking.id,
                        vendorId: callerId,
                        platformFee: platformFee.toFixed(2)
                    }
                });

                const timestamp = new Date().toISOString();

                // 1. Create Payout Record
                const payoutRef = db.collection("payments").doc(transfer.id);
                batch.create(payoutRef, {
                    amount: payoutAmount,
                    currency: payment.currency,
                    gateway: "stripe",
                    success: "SUCCESS",
                    status: "COMPLETED",
                    timestamp: timestamp,
                    transaction_id: transfer.id,
                    type: "payout",
                    vendor_id: callerId,
                    booking_id: booking.id,
                    data: transfer,
                    metadata: {
                        commission: platformFee,
                        original_payment_id: payment.id
                    },
                    created_at: timestamp,
                });

                // 2. Update Booking
                batch.update(bookingDocRef, {
                    payout_id: transfer.id,
                    payout_status: "COMPLETED",
                    payout_amount: payoutAmount,
                    updated_at: timestamp
                });

                // 3. Update Original Payment (Mark as paid out)
                // ✅ This will now work because payment.id is defined
                const originalPaymentRef = db.collection("payments").doc(payment.id);
                batch.update(originalPaymentRef, {
                    payout_id: transfer.id,
                    payout_status: "COMPLETED"
                });

                batchCount += 3;

                results.push({
                    bookingId: booking.id,
                    amount: payoutAmount,
                    status: "SUCCESS",
                    transferId: transfer.id
                });

            } catch (err: any) {
                console.error(`Failed to pay booking ${booking.id}:`, err);
                results.push({
                    bookingId: booking.id,
                    amount: 0,
                    status: "FAILED",
                    error: err.message
                });
            }
        }));

        // 6. Commit Database Changes
        // Only commit if we have operations (at least one success)
        if (batchCount > 0) {
            await batch.commit();
        }

        // 7. Return Summary
        const successCount = results.filter(r => r.status === "SUCCESS").length;
        const failedCount = results.filter(r => r.status === "FAILED").length;

        await sendNotificationToUserInternal(
            "Payouts",
            "A payout request has been submitted",
            {},
            callerId
        )

        return {
            success: true,
            vendor: callerId,
            processed: results.length,
            successful: successCount,
            failed: failedCount,
            results: results
        };

    } catch (error: any) {
        console.error("Bulk Payout Error:", error);
        throw new HttpsError('internal', error.message || "Failed to process payouts");
    }
});