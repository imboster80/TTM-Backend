require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Database ချိတ်ဆက်ခြင်း
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB Connected Successfully!'))
  .catch((err) => console.log('Connection Failed:', err));

// Cron-job လှမ်းခေါ်တဲ့အခါ Log အများကြီး မထွက်အောင် သီးသန့် route ထည့်ခြင်း
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

app.get('/', (req, res) => {
    res.send('Shop Bot Server is running!');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
