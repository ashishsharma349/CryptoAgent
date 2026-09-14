import express from "express";
import { connectDB, getAgentConfig, updateAgentConfig } from "./repo/mongo.repo";
import { config } from "./config/env.config";

const app = express();
app.use(express.json());
app.use("/admin", express.static("src/ui"));

app.get("/api/config", async (req, res) => {
    try {
        const conf = await getAgentConfig();
        res.json(conf);
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

app.post("/api/config", async (req, res) => {
    try {
        await updateAgentConfig(req.body);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
    console.log(`UI Server ONLY running on http://localhost:${PORT}/admin/dashboard.html`);
    console.log(`(No AI APIs or Telegram bots are running. Safe to test UI!)`);
});
