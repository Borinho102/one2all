// docs/swagger.ts
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import { Express } from "express";

export function registerSwagger(app: Express) {
    const options = {
        definition: {
            openapi: "3.0.0",
            info: {
                title: "MonLook API",
                version: "1.0.0",
            }
        },
        apis: ["./src/api/v1/*.ts"],
    };

    const specs = swaggerJsdoc(options);
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(specs));
}
