// middlewares/auth.ts
import { Request, Response, NextFunction } from "express";
import * as admin from "firebase-admin";

admin.initializeApp();

// @ts-ignore
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
        const token = req.headers.authorization?.split(" ")[1];

        if (!token) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const decoded = await admin.auth().verifyIdToken(token);
        (req as any).user = decoded;

        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid token" });
    }
}
