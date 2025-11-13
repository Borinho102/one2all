// utils/wrap.ts
import { Request, Response } from "express";

export const wrap = (handler: any) => {
    return (req: Request, res: Response) => handler(req as any, res as any);
};
