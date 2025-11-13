import express from "express";
import { onRequest } from "firebase-functions/https";
import { setGlobalOptions } from "firebase-functions";

// Import Firebase-style handlers
import {
  getData,
  getDocumentById,
  getDataFiltered,
  searchData
} from "./listing";

// Global config
setGlobalOptions({ maxInstances: 10 });

const app = express();

// Allow JSON bodies for POST
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Wrapper to satisfy TypeScript
const wrap = (fn: any) => {
  return (req: any, res: any) => fn(req, res);
};

// Routes
app.get("/services", wrap(getData));
app.get("/service-detail", wrap(getDocumentById));
app.get("/listing", wrap(getDataFiltered));
app.all("/search", wrap(searchData));

// Export Cloud Function
export const api = onRequest({ maxInstances: 5 }, app);
