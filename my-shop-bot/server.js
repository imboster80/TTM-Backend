const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { createWorker } = require('tesseract.js');
const cors = require('cors');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// MongoDB ချိတ်ဆက်ခြင်း
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("MongoDB Connected Successfully!"))
    .catch(err => console.log("DB Error:", err));

const upload = multer({ dest: 'uploads/' });

// Database Model
const Order = mongoose.model('Order', new mongoose.Schema({
    deviceId: String,
    transactionId: String,
    amount: String,
    ocrText: String,
    status: { type: String, default: 'Pending' },
    createdAt: { type: Date, default: Date.now }
}));

// Health Check
app.get('/', (req, res) => res.send("Bot Server with OCR is Active!"));

// Upload & OCR Process
app.post('/api/upload-payment', upload.single('screenshot'), async (req, res) => {
    let file = req.file;
    if (!file) return res.status(400).json({ error: 'No image provided' });

    try {
        const { deviceId, transactionId, amount } = req.body;

        // Tesseract OCR worker ဖန်တီး၍ ပုံကို စာဖတ်ခြင်း
        const worker = await createWorker('eng');
        const ret = await worker.recognize(file.path);
        await worker.terminate();

        const extractedText = ret.data.text || "";

        // Database ထဲသို့ သိမ်းဆည်းခြင်း
        const order = new Order({ 
            deviceId, 
            transactionId, 
            amount, 
            ocrText: extractedText 
        });
        await order.save();

        // Server ပေါ်က Temp ပုံဖိုင်ကို ဖျက်ပစ်ခြင်း
        if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }

        res.json({ 
            success: true, 
            message: 'Payment uploaded and OCR processed successfully!',
            ocrText: extractedText, 
            orderId: order._id 
        });

    } catch (err) {
        if (file && fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
