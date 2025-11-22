// index.ts

import express from "express";
import { onRequest } from "firebase-functions/https";
import { setGlobalOptions } from "firebase-functions";

import { corsMiddleware } from "./api/middlewares/cors";
import { listingRouter } from "./api/v1/listing.route";
import { registerSwagger } from "./api/docs/swagger";

console.log("[STARTUP] Firebase Functions initializing...");

// Global Firebase settings
setGlobalOptions({ maxInstances: 10 });

const app = express();

console.log("[STARTUP] Express app created");

// Middlewares
app.use(corsMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

console.log("[STARTUP] Middlewares registered");

// API Versioning
app.use("/api/v1/listing", listingRouter);

console.log("[STARTUP] Routes registered");

// Swagger Docs
try {
    registerSwagger(app);
    console.log("[STARTUP] Swagger registered successfully");
} catch (error) {
    console.error("[STARTUP] ERROR registering Swagger:", error);
    throw error;
}

console.log("[STARTUP] Exporting Cloud Function");

// Export as Cloud Function
export const api = onRequest({ maxInstances: 5 }, app);

console.log("[STARTUP] Cloud Function exported successfully");