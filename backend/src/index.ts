import express from 'express';
import { port } from './envdata/data.js';
import {vercelRouter} from './router/vercel.js';
import {userRouter} from './router/user.js';
const app = express();

app.use(express.json());

// Global request logger
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[RES] ${req.method} ${req.originalUrl} → ${res.statusCode} (${duration}ms)`);
  });
  next();
});

app.use("/api/user", userRouter);
app.use("/api/vercel",vercelRouter);
app.get("/api/health",(req,res)=>{res.send("server is running");})
app.get("/health",(req,res)=>{res.send("server is running");})
app.listen(port, () => {
  console.log(`app listening at ${port}`);
});