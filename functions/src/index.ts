// index.ts

import express from "express";
import { onRequest } from "firebase-functions/https";
import { setGlobalOptions } from "firebase-functions";

import { corsMiddleware } from "./api/middlewares/cors";
// import { authMiddleware } from "./api/middlewares/auth";
import { listingRouter } from "./api/v1/listing.route";
import { registerSwagger } from "./api/docs/swagger";

// Global Firebase settings
setGlobalOptions({ maxInstances: 10 });

const app = express();

// Middlewares
app.use(corsMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Optional authentication (enable or disable)
/// app.use(authMiddleware);

// API Versioning
app.use("/v1/listing", listingRouter);

// Swagger Docs
registerSwagger(app);

// Export as Cloud Function
export const api = onRequest({ maxInstances: 5 }, app);
