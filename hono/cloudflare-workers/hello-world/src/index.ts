import { Hono } from "hono";
import { Environment } from "./types/environment";
import { configure, tasks } from "@trigger.dev/sdk/v3";
import { helloWorldTask } from "./trigger/example";

const app = new Hono<Environment>();

app.use(async (c, next) => {
  configure({
    secretKey: c.env.TRIGGER_SECRET_KEY,
  });

  await next();
});

app.get("/", async (c) => {
  try {
    const handle = await tasks.trigger<typeof helloWorldTask>(
      "hello-world",
      "Kritik"
    );

    return c.json({ handle });
  } catch (error) {
    console.error(error);
    return c.json({
      error,
    });
  }
});

export default app;
