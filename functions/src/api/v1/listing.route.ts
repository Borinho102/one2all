// api/v1/listing.routes.ts

import { Router } from "express";
import { wrap } from "../utils/wrap";

import {
    getData,
    getDocumentById,
    getDataFiltered,
} from "../../listing";

import {
    searchData
} from "../../listing/search";

import {
    getBookingDetail, getBookingDetailById, getBookingsByMode, getVendorTodayBookings, sendBookingConfirmation
} from "../../listing/book";

import {
    fetchCollectionWithRelations
} from "../../listing/services";
import {
    sendBatchNotifications,
    sendNotification,
    sendNotificationCallable,
    sendNotificationToUser
} from "../../listing/alert";

import {
    userGetPayments,
    getPaymentDetails,
    vendorGetPayments,
    vendorStat,
    vendorGetPayouts,
    requestRefund,
    createPaymentIntent,
    stripeWebhook,
    createMerchantAccount,
    getVendorDashboardLink,
    getVendorKycStatus,
    releaseFundsToVendor
} from "../../listing/pay";

export const listingRouter = Router();


listingRouter.all("/pay/user", wrap(userGetPayments));
listingRouter.all("/pay/info", wrap(getPaymentDetails));
listingRouter.all("/pay/vendor", wrap(vendorGetPayments));
listingRouter.all("/pay/payout", wrap(vendorGetPayouts));
listingRouter.all("/pay/refund", wrap(requestRefund));
listingRouter.all("/pay/intent", wrap(createPaymentIntent));
listingRouter.all("/pay/merchant", wrap(createMerchantAccount));
listingRouter.all("/pay/webhook", wrap(stripeWebhook));
listingRouter.all("/pay/admin", wrap(getVendorDashboardLink));
listingRouter.all("/pay/status", wrap(getVendorKycStatus));
listingRouter.all("/pay/funds", wrap(releaseFundsToVendor));


listingRouter.all("/stats", wrap(vendorStat));


/**
 * @openapi
 * /api/v1/listing/all-data:
 *   get:
 *     summary: Get all data
 */
listingRouter.get("/all-data", wrap(getData));

/**
 * @openapi
 * /api/v1/listing/data-id:
 *   get:
 *     summary: Get one document by ID
 */
listingRouter.get("/data-id", wrap(getDocumentById));

/**
 * @openapi
 * /api/v1/listing/data-filter:
 *   get:
 *     summary: Get filtered data
 */
listingRouter.get("/data-filter", wrap(getDataFiltered));

/**
 * @openapi
 * /api/v1/listing/search:
 *   get:
 *     summary: Search with scoring & filtering
 */
listingRouter.all("/search", wrap(searchData));

/**
 * @openapi
 * /api/v1/listing/query:
 *   get:
 *     summary: Fetch collection with relations
 */
listingRouter.all("/query", wrap(fetchCollectionWithRelations));

/**
 * @openapi
 * /api/v1/listing/booking-detail:
 *   post:
 *     summary: Expand short booking/cart model to full detailed version
 *     description: |
 *       Converts a short cart model (with only IDs) to a full cart model with complete
 *       service details, variants, options, and selected choices.
 *       Accepts either a booking ID (fetches from database) or direct cart data.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - type: object
 *                 properties:
 *                   bookingId:
 *                     type: string
 *                     description: ID of the booking to expand
 *                     example: "booking-123"
 *               - type: object
 *                 properties:
 *                   cartData:
 *                     type: object
 *                     description: Short cart data to expand
 *                     properties:
 *                       id:
 *                         type: string
 *                       client_id:
 *                         type: string
 *                       vendor_id:
 *                         type: string
 *                       status:
 *                         type: string
 *                         enum: [PENDING, APPROVED, CANCELED, REJECTED]
 *                       items:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             service_id:
 *                               type: string
 *                             variant_id:
 *                               type: string
 *                             selected_options:
 *                               type: object
 *                               additionalProperties:
 *                                 type: string
 *     responses:
 *       200:
 *         description: Successfully expanded cart
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   description: Full CartModel with all service details
 *       404:
 *         description: Booking not found
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Server error
 */
listingRouter.post("/booking-detail", wrap(getBookingDetail));

/**
 * @openapi
 * /api/v1/listing/booking-detail-by-id:
 *   get:
 *     summary: Get full booking detail by ID (simplified GET endpoint)
 *     description: |
 *       Fetches a booking by ID from the database and expands it to full detailed version.
 *       This is a simplified GET alternative to the POST endpoint.
 *     parameters:
 *       - in: query
 *         name: bookingId
 *         required: true
 *         schema:
 *           type: string
 *         description: The booking ID to fetch and expand
 *         example: "booking-123"
 *     responses:
 *       200:
 *         description: Successfully expanded cart
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   description: Full CartModel with all service details
 *       404:
 *         description: Booking not found
 *       400:
 *         description: Missing bookingId parameter
 *       500:
 *         description: Server error
 */
listingRouter.get("/booking-detail-by-id", wrap(getBookingDetailById));

/**
 * @openapi
 * /api/v1/listing/bookings-by-mode:
 *   get:
 *     summary: Fetch bookings by client_id or vendor_id
 *     description: |
 *       Retrieves all bookings for a specific client or vendor.
 *       Optionally expands short cart models to full detailed versions.
 *       Supports filtering by status and limiting results.
 *     parameters:
 *       - in: query
 *         name: mode
 *         required: true
 *         schema:
 *           type: string
 *           enum: [client, vendor]
 *         description: Whether to fetch by client_id or vendor_id
 *         example: "client"
 *       - in: query
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The client_id or vendor_id to fetch bookings for
 *         example: "client-123"
 *       - in: query
 *         name: expand
 *         required: false
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Whether to expand short carts to full detail
 *         example: true
 *       - in: query
 *         name: status
 *         required: false
 *         schema:
 *           type: string
 *           enum: [PENDING, APPROVED, CANCELED, REJECTED]
 *         description: Filter bookings by status
 *         example: "PENDING"
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Maximum number of bookings to return
 *         example: 20
 *     responses:
 *       200:
 *         description: Successfully fetched bookings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     bookings:
 *                       type: array
 *                       items:
 *                         type: object
 *                     count:
 *                       type: integer
 *                     mode:
 *                       type: string
 *                     id:
 *                       type: string
 *                     expanded:
 *                       type: boolean
 *       400:
 *         description: Invalid parameters
 *       500:
 *         description: Server error
 *   post:
 *     summary: Fetch bookings by client_id or vendor_id (POST alternative)
 *     description: Same as GET endpoint but accepts parameters in request body
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - mode
 *               - id
 *             properties:
 *               mode:
 *                 type: string
 *                 enum: [client, vendor]
 *               id:
 *                 type: string
 *               expand:
 *                 type: boolean
 *                 default: false
 *               status:
 *                 type: string
 *                 enum: [PENDING, APPROVED, CANCELED, REJECTED]
 *               limit:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 100
 *                 default: 50
 *     responses:
 *       200:
 *         description: Successfully fetched bookings
 *       400:
 *         description: Invalid parameters
 *       500:
 *         description: Server error
 */
listingRouter.all("/bookings-by-mode", wrap(getBookingsByMode));
listingRouter.all("/today-booking", wrap(getVendorTodayBookings));
listingRouter.all("/booking", wrap(sendBookingConfirmation));

listingRouter.all("/notification", wrap(sendBatchNotifications));
listingRouter.all("/notify-user", wrap(sendNotificationToUser));
listingRouter.all("/notify", wrap(sendNotificationCallable));
listingRouter.all("/send-notify", wrap(sendNotification));