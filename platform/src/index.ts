import { createApp } from "./app.js";

const port = Number(process.env.PLATFORM_PORT ?? 3001);

createApp().listen(port, () => {
  console.log(`platform listening on port ${port}`);
});
