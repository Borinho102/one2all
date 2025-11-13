// api/v1/listing.routes.ts

import { Router } from "express";
import { wrap } from "../utils/wrap";

import {
    getData,
    getDocumentById,
    getDataFiltered,
    searchData
} from "../../listing";

export const listingRouter = Router();

/**
 * @openapi
 * /api/v1/listing/getData:
 *   get:
 *     summary: Get all data
 */
listingRouter.get("/getData", wrap(getData));

/**
 * @openapi
 * /api/v1/listing/getDocumentById:
 *   get:
 *     summary: Get one document by ID
 */
listingRouter.get("/getDocumentById", wrap(getDocumentById));

/**
 * @openapi
 * /api/v1/listing/getDataFiltered:
 *   get:
 *     summary: Get filtered data
 */
listingRouter.get("/getDataFiltered", wrap(getDataFiltered));

/**
 * @openapi
 * /api/v1/listing/search:
 *   get:
 *     summary: Search with scoring & filtering
 */
listingRouter.all("/search", wrap(searchData));
