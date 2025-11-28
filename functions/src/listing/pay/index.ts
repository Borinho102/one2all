import * as admin from "firebase-admin";
import Stripe from "stripe";
import { Request, Response } from "express";
import { onCall, CallableRequest, HttpsError, onRequest } from "firebase-functions/v2/https"; // Added onRequest to v2 imports
import config from "../../config";
import { defineSecret } from "firebase-functions/params";

// Initialize Firebase Admin
if (!admin.apps.length) {
    admin.initializeApp();
}

// FIX: Enable ignoreUndefinedProperties to prevent crashes if other optional fields are undefined
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

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
}

interface CreatePaymentIntentResponse {
    clientSecret: string;
    paymentIntentId: string;
}

interface RequestRefundRequest {
    bookingId: string;
    reason: string;
}

interface RequestRefundResponse {
    success: boolean;
    refundId: string;
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

// ==================== 1. CREATE PAYMENT INTENT ====================
export const createPaymentIntent = onCall(
    async (request: CallableRequest<CreatePaymentIntentRequest>): Promise<CreatePaymentIntentResponse> => {
        if (!request.auth || !request.auth.uid) {
            throw new HttpsError(
                "unauthenticated",
                "User must be authenticated"
            );
        }

        const { bookingId, amount, currency = "usd", email } = request.data;
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

            const customer = await stripe.customers.create({
                email: email,
                metadata: {
                    userId,
                    bookingId,
                },
            });

            const paymentIntent = await stripe.paymentIntents.create({
                amount: Math.round(amount * 100),
                currency,
                customer: customer.id,
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
                timestamp: timestamp,
                transaction_id: paymentIntent.id,
                type: "payment",
                data: {
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
        timestamp: new Date().toISOString(),
        transaction_id: chargeId,
        type: "payment",
        data: {
           user_id: userId,
           vendor_id: vendor_id,
           booking_id: bookingId,
           metadata: metadata, currency: paymentIntent.currency
        },
        updated_at: new Date().toISOString(),
    });

    // Step 2: Update booking with new field names
    await db.collection("booking").doc(bookingId).update({
        status: "PAID",
        is_paid: true,
        payment_id: paymentId,
        updated_at: new Date().toISOString(),
    });

    // Step 3: Record vendor payment (if vendors subcollection exists)
    // await db
    //     .collection("vendors")
    //     .doc(vendor_id)
    //     .collection("payments")
    //     .doc(paymentId)
    //     .set({
    //         payment_id: paymentId,
    //         booking_id: bookingId,
    //         client_id: userId,
    //         amount: paymentIntent.amount / 100,
    //         currency: paymentIntent.currency,
    //         data: {
    //             gateway: "stripe",
    //             success: "SUCCESS",
    //             timestamp: new Date().toISOString(),
    //             transaction_id: chargeId,
    //             type: "payment",
    //         },
    //         created_at: new Date().toISOString(),
    //     });

    console.log(`Payment succeeded: ${paymentId} for booking: ${bookingId}`);
}

// ==================== 4. PAYMENT FAILED HANDLER ====================
async function handlePaymentFailed(paymentIntent: Stripe.PaymentIntent) {
    const paymentId = paymentIntent.id;
    const metadata = paymentIntent.metadata || {};
    const bookingId = metadata.bookingId;

    await db.collection("payments").doc(paymentId).update({
        status: "FAILED",
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
async function handleRefund(charge: Stripe.Charge) {
    const chargeId = charge.id;
    const refundAmount = charge.amount_refunded;

    const paymentSnapshot = await db
        .collection("payments")
        .where("transaction_id", "==", chargeId)
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
        data: charge,
        updated_at: new Date().toISOString(),
    });

    await db.collection("bookings").doc(payment.booking_id).update({
        refund_id: chargeId,
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

            // Step 2: Check if booking status is "REFUND"
            if (bookingData?.status !== "REFUND") {
                throw new HttpsError(
                    "failed-precondition",
                    `Booking status must be REFUND to request refund. Current status: ${bookingData?.status}`
                );
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
            if (paymentData?.status !== "SUCCESS") {
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

            // Step 6: Update payment document to mark as refunded
            await paymentDoc.ref.update({
                amount: 0, // Refunded amount is 0
                data: {
                    ...paymentData.data,
                    success: "SUCCESS",
                    type: "refund",
                    refund_id: refund.id,
                    refund_timestamp: new Date().toISOString(),
                    refund_reason: reason,
                },
                success: "SUCCESS",
                type: "refund",
                updated_at: new Date().toISOString(),
            });

            // Step 7: Update booking refund_id and status
            await db.collection("booking").doc(bookingId).update({
                refund_id: refund.id,
                status: "REFUNDED",
                updated_at: new Date().toISOString(),
            });

            return {
                success: true,
                refundId: refund.id,
                amount: paymentData.amount,
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
            console.log(`Fetching payments for user: ${userId}`);

            let bookingsQuery = db
                .collection("booking")
                .where("vendor_id", "==", userId)
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

            bookingsDocs.forEach(doc => {
                const data = doc.data();
                if (data.payment_id?.trim()) {
                    uniquePaymentIds.add(data.payment_id.trim());
                }
            });

            // Fetch payment and refund documents
            const [paymentDocs] = await Promise.all([
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
            ]);

            // Combine, filter, and sort by timestamp
            const allTransactions = [...paymentDocs]
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