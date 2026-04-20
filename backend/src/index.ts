import express from 'express';
import { port } from './envdata/data.js';
import {vercelRouter} from './router/vercel.js';
import {userRouter} from './router/user.js';
const app = express();

app.use(express.json());
app.use("/api/user", userRouter);
app.use("/api/vercel",vercelRouter);
app.get("/api/health",(req,res)=>{res.send("server is running");})
app.get("/health",(req,res)=>{res.send("server is running");})
app.listen(port, () => {
  console.log(`app listening at ${port}`);
});