const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createWorker } = require('tesseract.js');
const cors = require('cors');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI)
    .then(() => console.log("MongoDB Connected Successfully!"))
    .catch(err => console.log("DB Error:", err));

const upload = multer({ dest: 'uploads/' });
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_123';
const HARDCODED_DEV_TOKEN = process.env.HARDCODED_DEV_TOKEN || 'ttm_master_dev_token_2026';

// ==========================================
// DATABASE SCHEMAS & MODELS
// ==========================================
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password_hash: { type: String, required: true },
    role: { type: String, enum: ['User', 'Admin', 'Developer'], default: 'User' },
    vip_expiry: { type: Date, default: null },
    is_banned: { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const BotProfileSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    profile_name: String,
    bot_token: String,
    admin_id: String
});
const BotProfile = mongoose.model('BotProfile', BotProfileSchema);

const LicenseKeySchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    key_string: { type: String, unique: true },
    expiry_date: Date,
    status: { type: String, enum: ['Active', 'Used', 'Expired'], default: 'Active' }
});
const LicenseKey = mongoose.model('LicenseKey', LicenseKeySchema);

const PaymentSchema = new mongoose.Schema({
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    transaction_id: String,
    amount: Number,
    screenshot_url: String,
    ocr_text: String,
    status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
    created_at: { type: Date, default: Date.now }
});
const Payment = mongoose.model('Payment', PaymentSchema);

const RedeemCodeSchema = new mongoose.Schema({
    code: { type: String, unique: true, required: true },
    days: { type: Number, required: true },
    max_uses: { type: Number, required: true },
    used_count: { type: Number, default: 0 }
});
const RedeemCode = mongoose.model('RedeemCode', RedeemCodeSchema);


// ==========================================
// MIDDLEWARES (Authentication & Roles)
// ==========================================
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access token missing' });

    if (token === HARDCODED_DEV_TOKEN) {
        req.user = { 
            id: '000000000000000000000000', 
            username: 'MasterDeveloper', 
            role: 'Developer' 
        };
        return next();
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token' });
        req.user = user;
        next();
    });
};

const verifyRole = (roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Permission denied: Insufficient role' });
        }
        next();
    };
};


// ==========================================
// 1. USER & AUTHENTICATION SYSTEM
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, role } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const assignedRole = role && ['User', 'Admin'].includes(role) ? role : 'User';

        const newUser = new User({
            username,
            password_hash: hashedPassword,
            role: assignedRole
        });
        await newUser.save();
        res.json({ success: true, message: `Account registered successfully as ${assignedRole}` });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user || user.is_banned) return res.status(400).json({ error: 'Invalid credentials or user banned' });

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });

        const token = jwt.sign({ id: user._id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, role: user.role });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/me', verifyToken, async (req, res) => {
    try {
        if (req.user.id === '000000000000000000000000') {
            return res.json({
                success: true,
                user: {
                    _id: '000000000000000000000000',
                    username: 'MasterDeveloper',
                    role: 'Developer',
                    vip_expiry: null,
                    isVip: true,
                    is_banned: false,
                    created_at: new Date()
                }
            });
        }

        const user = await User.findById(req.user.id).select('-password_hash');
        const now = new Date();
        const isVip = user.vip_expiry && user.vip_expiry > now;

        res.json({ 
            success: true, 
            user: {
                _id: user._id,
                username: user.username,
                role: user.role,
                vip_expiry: user.vip_expiry,
                isVip: isVip,
                is_banned: user.is_banned,
                created_at: user.created_at
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/reset-password', verifyToken, async (req, res) => {
    try {
        const { newPassword } = req.body;
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await User.findByIdAndUpdate(req.user.id, { password_hash: hashedPassword });
        res.json({ success: true, message: 'Password reset successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ==========================================
// 2. BOT MANAGEMENT SYSTEM
// ==========================================
app.get('/api/profiles', verifyToken, async (req, res) => {
    try {
        const profiles = await BotProfile.find({ user_id: req.user.id });
        res.json({ success: true, profiles });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/profiles', verifyToken, async (req, res) => {
    try {
        const { profile_name, bot_token, admin_id } = req.body;
        const newProfile = new BotProfile({ 
            user_id: req.user.id, 
            profile_name, 
            bot_token, 
            admin_id 
        });
        await newProfile.save();
        res.json({ success: true, message: 'Bot profile saved', profile: newProfile });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/profiles/:id', verifyToken, async (req, res) => {
    try {
        const updated = await BotProfile.findOneAndUpdate(
            { _id: req.params.id, user_id: req.user.id },
            req.body,
            { new: true }
        );
        res.json({ success: true, message: 'Profile updated', profile: updated });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/profiles/:id', verifyToken, async (req, res) => {
    try {
        await BotProfile.findOneAndDelete({ _id: req.params.id, user_id: req.user.id });
        res.json({ success: true, message: 'Profile deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ==========================================
// 3. PAYMENT & VIP SUBSCRIPTION SYSTEM (OCR)
// ==========================================
app.post('/api/payment/upload', verifyToken, upload.single('screenshot'), async (req, res) => {
    let file = req.file;
    if (!file) return res.status(400).json({ error: 'No screenshot provided' });

    try {
        const { transaction_id, amount } = req.body;

        const worker = await createWorker('eng');
        const ret = await worker.recognize(file.path);
        await worker.terminate();

        const extractedText = ret.data.text || "";

        const payment = new Payment({
            user_id: req.user.id,
            transaction_id,
            amount: Number(amount),
            screenshot_url: file.path,
            ocr_text: extractedText,
            status: 'pending'
        });
        await payment.save();

        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

        res.json({ success: true, message: 'Payment uploaded and OCR processed successfully', orderId: payment._id, ocrText: extractedText });
    } catch (err) {
        if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/payment/status/:orderId', verifyToken, async (req, res) => {
    try {
        const payment = await Payment.findOne({ _id: req.params.orderId, user_id: req.user.id });
        if (!payment) return res.status(404).json({ error: 'Payment not found' });
        res.json({ success: true, status: payment.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/subscription/status', verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const now = new Date();
        const isVip = user.vip_expiry && user.vip_expiry > now;
        res.json({ success: true, vip_expiry: user.vip_expiry, isVip });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/user/codes/redeem', verifyToken, async (req, res) => {
    try {
        const { code } = req.body;
        const codeDoc = await RedeemCode.findOne({ code });
        
        if (!codeDoc || codeDoc.used_count >= codeDoc.max_uses) {
            return res.status(400).json({ error: 'Invalid or fully used redeem code' });
        }

        const user = await User.findById(req.user.id);
        const now = new Date();
        let currentExpiry = (user.vip_expiry && user.vip_expiry > now) ? user.vip_expiry : now;
        
        user.vip_expiry = new Date(currentExpiry.getTime() + (codeDoc.days * 24 * 60 * 60 * 1000));
        codeDoc.used_count += 1;

        await user.save();
        await codeDoc.save();

        res.json({ success: true, message: `Successfully redeemed ${codeDoc.days} VIP days!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ==========================================
// 4. ADMIN MANAGEMENT SYSTEM
// ==========================================
app.get('/api/admin/keys', verifyToken, verifyRole(['Admin', 'Developer']), async (req, res) => {
    try {
        const keys = await LicenseKey.find();
        res.json({ success: true, keys });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update License Key Generation API to use expiry_hours
app.post('/api/admin/generate-key', verifyToken, verifyRole(['Admin', 'Developer']), async (req, res) => {
    try {
        const { expiry_hours } = req.body;
        const hours = Number(expiry_hours) || 24; // default သို့မဟုတ် ပို့လာသည့် နာရီ
        const keyString = 'KEY-' + Math.random().toString(36).substring(2, 10).toUpperCase();
        
        const expiryDate = new Date();
        expiryDate.setTime(expiryDate.getTime() + (hours * 60 * 60 * 1000));

        const newKey = new LicenseKey({ key_string: keyString, expiry_date: expiryDate });
        await newKey.save();
        res.json({ success: true, key: newKey });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/admin/keys/:id', verifyToken, verifyRole(['Admin', 'Developer']), async (req, res) => {
    try {
        await LicenseKey.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: 'License key deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/pending-payments', verifyToken, verifyRole(['Admin', 'Developer']), async (req, res) => {
    try {
        const payments = await Payment.find({ status: 'pending' }).populate('user_id', 'username');
        res.json({ success: true, payments });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/approve-payment/:paymentId', verifyToken, verifyRole(['Admin', 'Developer']), async (req, res) => {
    try {
        const payment = await Payment.findById(req.params.paymentId);
        if (!payment) return res.status(404).json({ error: 'Payment not found' });
        if (payment.status === 'success') return res.status(400).json({ error: 'Payment already approved' });

        const user = await User.findById(payment.user_id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const daysToAdd = Math.floor(payment.amount / 1000) || 1; 

        const now = new Date();
        let currentExpiry = (user.vip_expiry && user.vip_expiry > now) ? user.vip_expiry : now;
        
        user.vip_expiry = new Date(currentExpiry.getTime() + (daysToAdd * 24 * 60 * 60 * 1000));
        payment.status = 'success';

        await user.save();
        await payment.save();

        res.json({ success: true, message: `Payment approved successfully. Added ${daysToAdd} VIP days to user.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/codes/create', verifyToken, verifyRole(['Admin', 'Developer']), async (req, res) => {
    try {
        const { code, days, max_uses } = req.body;
        const newCode = new RedeemCode({ 
            code, 
            days: Number(days), 
            max_uses: Number(max_uses) 
        });
        await newCode.save();
        res.json({ success: true, message: 'Redeem code created successfully', redeemCode: newCode });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/admin/codes/all', verifyToken, verifyRole(['Admin', 'Developer']), async (req, res) => {
    try {
        const codes = await RedeemCode.find();
        res.json({ success: true, codes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/codes/:id', verifyToken, verifyRole(['Admin', 'Developer']), async (req, res) => {
    try {
        const deletedCode = await RedeemCode.findByIdAndDelete(req.params.id);
        if (!deletedCode) {
            return res.status(404).json({ error: 'Redeem code not found' });
        }
        res.json({ success: true, message: 'Redeem code deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ==========================================
// 5. DEVELOPER (SUPER ADMIN) MASTER CONTROL
// ==========================================
app.get('/api/dev/users/all', verifyToken, verifyRole(['Developer']), async (req, res) => {
    try {
        const users = await User.find().select('-password_hash');
        res.json({ success: true, users });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/dev/users/:id', verifyToken, verifyRole(['Developer']), async (req, res) => {
    try {
        const updateData = { ...req.body };
        if (updateData.password) {
            updateData.password_hash = await bcrypt.hash(updateData.password, 10);
            delete updateData.password;
        }
        const updatedUser = await User.findByIdAndUpdate(req.params.id, updateData, { new: true }).select('-password_hash');
        res.json({ success: true, message: 'User updated by developer', user: updatedUser });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/dev/users/:id', verifyToken, verifyRole(['Developer']), async (req, res) => {
    try {
        const deletedUser = await User.findByIdAndDelete(req.params.id);
        if (!deletedUser) {
            return res.status(404).json({ error: 'User not found' });
        }
        await BotProfile.deleteMany({ user_id: req.params.id });
        await Payment.deleteMany({ user_id: req.params.id });

        res.json({ success: true, message: 'User deleted successfully by developer' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/dev/dashboard-stats', verifyToken, verifyRole(['Developer']), async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const totalBots = await BotProfile.countDocuments();
        const pendingPayments = await Payment.countDocuments({ status: 'pending' });
        
        res.json({
            success: true,
            stats: {
                totalUsers,
                totalBots,
                pendingPayments
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Root Health Check
app.get('/', (req, res) => res.send("Full Backend Server with Expiry Hours is Active!"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
