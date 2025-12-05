// middlewares/auth.ts
import { Request, Response, NextFunction } from "express";
import * as admin from "firebase-admin";

// Prevent multiple initializations if this file is imported multiple times
if (admin.apps.length === 0) {
    admin.initializeApp();
}

// @ts-ignore
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {

    // ============================================================
    // 🛡️ LAYER 1: Firebase App Check (Verify the App)
    // ============================================================
    const appCheckToken = req.header("X-Firebase-AppCheck");

    if (!appCheckToken) {
        return res.status(401).json({
            error: "Unauthorized App",
            message: "Missing App Check Token"
        });
    }

    try {
        // Verify the App Check token
        await admin.appCheck().verifyToken(appCheckToken);
    } catch (err) {
        return res.status(401).json({
            error: "Unauthorized App",
            message: "Invalid App Check Token"
        });
    }

    // ============================================================
    // 👤 LAYER 2: Firebase Auth (Verify the User)
    // ============================================================
    try {
        const authToken = req.headers.authorization?.split(" ")[1];

        if (!authToken) {
            return res.status(401).json({ error: "Unauthorized User" });
        }

        const decoded = await admin.auth().verifyIdToken(authToken);

        // Attach user data to request
        (req as any).user = decoded;
        // Securely attach the UID (easier to access later)
        (req as any).uid = decoded.uid;

        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid User Token" });
    }
}