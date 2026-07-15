import Fastify from "fastify";
import { app } from "./app.ts";

const server = Fastify({
  logger: {
    level: "info", // updated to config.LOG_LEVEL once env plugin loads
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
      },
    },
  },
});

server.register(app);

const gracefulShutdown = async (signal: string) => {
  server.log.info(`Received ${signal}, shutting down gracefully`);
  try {
    await server.close();
    server.log.info("Server closed successfully");
    process.exit(0);
  } catch (error) {
    server.log.error(error, "Error during shutdown");
    process.exit(1);
  }
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

const start = async () => {
  try {
    await server.ready();

    const port = server.config.PORT;
    const host = server.config.HOST;

    await server.listen({ port, host });

    server.log.info(`Listening at http://${host}:${port}`);
    server.log.info(`Environment: ${server.config.NODE_ENV}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
