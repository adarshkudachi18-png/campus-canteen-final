require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const nodemailer = require('nodemailer');
const AWS = require('aws-sdk');
const Razorpay = require('razorpay');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// AWS DynamoDB Configuration
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

const dynamoDB = new AWS.DynamoDB.DocumentClient();

// Razorpay Configuration
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Email Configuration
const Brevo = require('@getbrevo/brevo');
const brevo = new Brevo.TransactionalEmailsApi();

brevo.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);


// Data Directory
const DATA_DIR = path.join(__dirname, 'data');

// Initialize data directory and files
async function initializeDataFiles() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    
    const files = {
      'headquarters.json': { email: process.env.HQ_EMAIL, password: await bcrypt.hash(process.env.HQ_PASSWORD, 10) },
      'colleges.json': [],
      'admins.json': [],
      'users.json': [],
      'menu.json': [],
      'orders.json': [],
      'otps.json': [],
      'notifications.json': [],
      'settings.json': [],
      'order-counter.json': { date: new Date().toDateString(), counter: 0 }
    };

    for (const [filename, defaultData] of Object.entries(files)) {
      const filePath = path.join(DATA_DIR, filename);
      try {
        await fs.access(filePath);
      } catch {
        await fs.writeFile(filePath, JSON.stringify(defaultData, null, 2));
      }
    }
    
    console.log('✅ Data files initialized');
  } catch (error) {
    console.error('❌ Error initializing data files:', error);
  }
}

// Dual Storage Helper Functions
async function saveToJSON(filename, data) {
  try {
    const filePath = path.join(DATA_DIR, filename);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`Error saving to ${filename}:`, error);
  }
}

async function readFromJSON(filename) {
  try {
    const filePath = path.join(DATA_DIR, filename);
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading from ${filename}:`, error);
    return Array.isArray(filename) ? [] : {};
  }
}

async function saveToDynamoDB(tableName, item) {
  try {
    await dynamoDB.put({
      TableName: tableName,
      Item: item
    }).promise();
  } catch (error) {
    console.error(`Error saving to DynamoDB ${tableName}:`, error);
  }
}

async function queryDynamoDB(tableName, params = {}) {
  try {
    const result = await dynamoDB.scan({
      TableName: tableName,
      ...params
    }).promise();
    return result.Items || [];
  } catch (error) {
    console.error(`Error querying DynamoDB ${tableName}:`, error);
    return [];
  }
}

async function saveDualStorage(filename, tableName, data) {
  await saveToJSON(filename, data);
  if (tableName && data.id) {
    await saveToDynamoDB(tableName, data);
  }
}

// Generate Order ID
async function generateOrderID() {
  const counter = await readFromJSON('order-counter.json');
  const today = new Date().toDateString();
  
  if (counter.date !== today) {
    counter.date = today;
    counter.counter = 1;
  } else {
    counter.counter += 1;
  }
  
  await saveToJSON('order-counter.json', counter);
  return `CC-#${counter.counter}`;
}

// Generate 4-digit OTP
function generate4DigitOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// Generate 6-digit OTP for password reset
function generate6DigitOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send Email Helper
async function sendEmail(to, subject, html) {
  try {
    const sendSmtpEmail = {
      sender: { name: 'Campus Canteen', email: '00adarsh.kudachi00@gmail.com'},
      to: [{ email: to }],
      subject: subject,
      htmlContent: html,
    };

    const response = await brevo.sendTransacEmail(sendSmtpEmail);
    console.log(`✅ Brevo email sent to ${to}`, response.messageId);
  } catch (error) {
    console.error('❌ Brevo email error:', error.response?.body || error);
  }
}


// ====================
// HEADQUARTERS ROUTES
// ====================

// HQ Login
app.post('/api/hq/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const hq = await readFromJSON('headquarters.json');
    
    if (email !== hq.email) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(password, hq.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ role: 'headquarters' }, process.env.JWT_SECRET);
    res.json({ success: true, token, user: { email: hq.email, role: 'headquarters' } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create Admin Account
app.post('/api/hq/create-admin', async (req, res) => {
  try {
    const { name, email, phone, collegeName, canteenName, address } = req.body;
    
    const admins = await readFromJSON('admins.json');
    
    if (admins.find(a => a.email === email)) {
      return res.status(400).json({ error: 'Admin already exists' });
    }
    
    const tempPassword = 'Admin@' + Math.random().toString(36).slice(-8);
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    
    const admin = {
      id: uuidv4(),
      name,
      email,
      phone,
      password: hashedPassword,
      collegeName,
      canteenName,
      address,
      status: 'active',
      createdAt: new Date().toISOString(),
      studentCount: 0
    };
    
    admins.push(admin);
    await saveToJSON('admins.json', admins);
    await saveToDynamoDB(process.env.ADMINS_TABLE, admin);
    
    // Create college entry
    const colleges = await readFromJSON('colleges.json');
    if (!colleges.find(c => c.id === admin.id)) {
      colleges.push({
        id: admin.id,
        collegeName,
        canteenName,
        adminEmail: email
      });
      await saveToJSON('colleges.json', colleges);
    }
    
    // Send welcome email
    await sendEmail(email, 'Welcome to Campus Canteen - Admin Account Created', `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px; border-radius: 10px;">
        <h2 style="color: white; text-align: center;">🎉 Welcome to Campus Canteen!</h2>
        <div style="background: white; padding: 30px; border-radius: 10px; margin-top: 20px;">
          <h3 style="color: #667eea;">Hello ${name}!</h3>
          <p>Your admin account has been successfully created.</p>
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 5px 0;"><strong>College:</strong> ${collegeName}</p>
            <p style="margin: 5px 0;"><strong>Canteen:</strong> ${canteenName}</p>
            <p style="margin: 5px 0;"><strong>Email:</strong> ${email}</p>
            <p style="margin: 5px 0;"><strong>Temporary Password:</strong> <code style="background: #e0e7ff; padding: 5px 10px; border-radius: 4px;">${tempPassword}</code></p>
          </div>
          <p style="color: #ef4444; font-size: 14px;">⚠️ Please change your password after first login.</p>
          <a href="http://localhost:3000/admin-login.html" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 8px; margin-top: 20px;">Login to Dashboard</a>
        </div>
      </div>
    `);
    
    res.json({ success: true, admin: { ...admin, tempPassword } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get All Admins
app.get('/api/hq/admins', async (req, res) => {
  try {
    const admins = await readFromJSON('admins.json');
    const users = await readFromJSON('users.json');
    
    const adminsWithStats = admins.map(admin => ({
      ...admin,
      password: undefined,
      studentCount: users.filter(u => u.adminId === admin.id).length
    }));
    
    res.json(adminsWithStats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Admin Status
app.patch('/api/hq/admins/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    const admins = await readFromJSON('admins.json');
    const admin = admins.find(a => a.id === id);
    
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }
    
    admin.status = status;
    await saveToJSON('admins.json', admins);
    await saveToDynamoDB(process.env.ADMINS_TABLE, admin);
    
    res.json({ success: true, admin });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Admin
app.delete('/api/hq/admins/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    let admins = await readFromJSON('admins.json');
    admins = admins.filter(a => a.id !== id);
    await saveToJSON('admins.json', admins);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================
// ADMIN ROUTES
// ====================

// Admin Login
app.post('/api/auth/admin-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const admins = await readFromJSON('admins.json');
    const admin = admins.find(a => a.email === email);
    
    if (!admin || admin.status !== 'active') {
      return res.status(401).json({ error: 'Invalid credentials or account inactive' });
    }
    
    const validPassword = await bcrypt.compare(password, admin.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ id: admin.id, role: 'admin' }, process.env.JWT_SECRET);
    res.json({ 
      success: true, 
      token, 
      user: { 
        ...admin, 
        password: undefined 
      } 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Admin Profile
app.get('/api/admin/profile/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const admins = await readFromJSON('admins.json');
    const admin = admins.find(a => a.id === id);
    
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }
    
    const users = await readFromJSON('users.json');
    const studentCount = users.filter(u => u.adminId === id).length;
    
    res.json({ ...admin, password: undefined, studentCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Register Student (Admin Only)
app.post('/api/admin/register-student', async (req, res) => {
  try {
    const { name, email, phone, studentId, department, year, adminId } = req.body;
    
    const users = await readFromJSON('users.json');
    
    if (users.find(u => u.email === email || u.studentId === studentId)) {
      return res.status(400).json({ error: 'Student with this email or ID already exists' });
    }
    
    const tempPassword = 'Student@' + Math.random().toString(36).slice(-8);
    const hashedPassword = await bcrypt.hash(tempPassword, 10);
    
    const admins = await readFromJSON('admins.json');
    const admin = admins.find(a => a.id === adminId);
    
    const user = {
      id: uuidv4(),
      name,
      email,
      phone,
      studentId,
      department,
      year,
      password: hashedPassword,
      adminId,
      collegeName: admin.collegeName,
      canteenName: admin.canteenName,
      createdAt: new Date().toISOString(),
      preferences: {
        vegOnly: false,
        notifications: true,
        emailUpdates: true
      }
    };
    
    users.push(user);
    await saveToJSON('users.json', users);
    await saveToDynamoDB(process.env.USERS_TABLE, user);
    
    // Send welcome email
    await sendEmail(email, 'Welcome to ' + admin.canteenName, `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px; border-radius: 10px;">
        <h2 style="color: white; text-align: center;">🎓 Welcome to ${admin.canteenName}!</h2>
        <div style="background: white; padding: 30px; border-radius: 10px; margin-top: 20px;">
          <h3 style="color: #667eea;">Hello ${name}!</h3>
          <p>Your student account has been created for ${admin.collegeName} canteen.</p>
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 5px 0;"><strong>Student ID:</strong> ${studentId}</p>
            <p style="margin: 5px 0;"><strong>Email:</strong> ${email}</p>
            <p style="margin: 5px 0;"><strong>Temporary Password:</strong> <code style="background: #e0e7ff; padding: 5px 10px; border-radius: 4px;">${tempPassword}</code></p>
          </div>
          <p style="color: #ef4444; font-size: 14px;">⚠️ Please change your password after first login.</p>
          <a href="http://localhost:3000/login.html" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 8px; margin-top: 20px;">Login Now</a>
        </div>
      </div>
    `);
    
    res.json({ success: true, user: { ...user, password: undefined, tempPassword } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get All Students (Admin)
app.get('/api/admin/:adminId/students', async (req, res) => {
  try {
    const { adminId } = req.params;
    const users = await readFromJSON('users.json');
    
    const students = users
      .filter(u => u.adminId === adminId)
      .map(u => ({ ...u, password: undefined }));
    
    res.json(students);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================
// STUDENT AUTH ROUTES
// ====================

// Student Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const users = await readFromJSON('users.json');
    const user = users.find(u => u.email === email);
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ id: user.id, role: 'student' }, process.env.JWT_SECRET);
    res.json({ 
      success: true, 
      token, 
      user: { ...user, password: undefined } 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send OTP
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    
    const users = await readFromJSON('users.json');
    const user = users.find(u => u.email === email);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const otp = generate6DigitOTP();
    const otps = await readFromJSON('otps.json');
    
    otps.push({
      email,
      otp,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    });
    
    await saveToJSON('otps.json', otps);
    
    await sendEmail(email, 'Password Reset OTP', `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px; background: #f8fafc; border-radius: 10px;">
        <h2 style="color: #667eea; text-align: center;">🔐 Password Reset</h2>
        <p>Your OTP for password reset is:</p>
        <div style="background: white; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; color: #667eea; letter-spacing: 10px; border-radius: 8px; margin: 20px 0;">
          ${otp}
        </div>
        <p style="color: #64748b; font-size: 14px; text-align: center;">This OTP will expire in 10 minutes.</p>
      </div>
    `);
    
    res.json({ success: true, message: 'OTP sent successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify OTP
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    
    const otps = await readFromJSON('otps.json');
    const otpEntry = otps.find(o => o.email === email && o.otp === otp);
    
    if (!otpEntry) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }
    
    if (new Date() > new Date(otpEntry.expiresAt)) {
      return res.status(400).json({ error: 'OTP expired' });
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset Password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    
    const users = await readFromJSON('users.json');
    const user = users.find(u => u.email === email);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    user.password = await bcrypt.hash(newPassword, 10);
    await saveToJSON('users.json', users);
    await saveToDynamoDB(process.env.USERS_TABLE, user);
    
    // Clear OTPs
    let otps = await readFromJSON('otps.json');
    otps = otps.filter(o => o.email !== email);
    await saveToJSON('otps.json', otps);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================
// MENU ROUTES
// ====================

// Get Menu (by admin/college)
app.get('/api/menu', async (req, res) => {
  try {
    const { adminId } = req.query;
    const menu = await readFromJSON('menu.json');
    
    const filteredMenu = adminId 
      ? menu.filter(item => item.adminId === adminId)
      : menu;
    
    res.json(filteredMenu);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Menu Item
app.post('/api/menu', async (req, res) => {
  try {
    const { name, category, price, description, image, isVeg, adminId } = req.body;
    
    const menu = await readFromJSON('menu.json');
    
    const item = {
      id: uuidv4(),
      name,
      category,
      price,
      description,
      image,
      isVeg,
      adminId,
      available: true,
      createdAt: new Date().toISOString()
    };
    
    menu.push(item);
    await saveToJSON('menu.json', menu);
    await saveToDynamoDB(process.env.MENU_TABLE, item);
    
    // Notify all students of new item
    const users = await readFromJSON('users.json');
    const students = users.filter(u => u.adminId === adminId && u.preferences?.notifications);
    
    const admins = await readFromJSON('admins.json');
    const admin = admins.find(a => a.id === adminId);
    
    for (const student of students) {
      await sendEmail(student.email, `New Item Added: ${name}`, `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px; border-radius: 10px;">
          <h2 style="color: white; text-align: center;">🍽️ New Item Available!</h2>
          <div style="background: white; padding: 30px; border-radius: 10px; margin-top: 20px;">
            <h3 style="color: #667eea;">${name}</h3>
            ${image ? `<img src="${image}" style="width: 100%; border-radius: 8px; margin: 15px 0;" />` : ''}
            <p>${description}</p>
            <p style="font-size: 24px; color: #10b981; font-weight: bold;">₹${price}</p>
            <span style="background: ${isVeg ? '#10b981' : '#ef4444'}; color: white; padding: 5px 15px; border-radius: 20px; font-size: 12px;">
              ${isVeg ? '🟢 VEG' : '🔴 NON-VEG'}
            </span>
            <a href="http://localhost:3000/student-menu.html" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 8px; margin-top: 20px;">Order Now</a>
          </div>
        </div>
      `);
    }
    
    res.json({ success: true, item });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Menu Item
app.put('/api/menu/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const menu = await readFromJSON('menu.json');
    const item = menu.find(i => i.id === id);
    
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    
    Object.assign(item, updates);
    await saveToJSON('menu.json', menu);
    await saveToDynamoDB(process.env.MENU_TABLE, item);
    
    res.json({ success: true, item });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Menu Item
app.delete('/api/menu/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    let menu = await readFromJSON('menu.json');
    menu = menu.filter(i => i.id !== id);
    await saveToJSON('menu.json', menu);
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle Availability
app.patch('/api/menu/:id/availability', async (req, res) => {
  try {
    const { id } = req.params;
    
    const menu = await readFromJSON('menu.json');
    const item = menu.find(i => i.id === id);
    
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }
    
    item.available = !item.available;
    await saveToJSON('menu.json', menu);
    await saveToDynamoDB(process.env.MENU_TABLE, item);
    
    res.json({ success: true, item });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Top 3 Popular Items
app.get('/api/menu/popular/:adminId', async (req, res) => {
  try {
    const { adminId } = req.params;
    const orders = await readFromJSON('orders.json');
    const menu = await readFromJSON('menu.json');
    
    const itemCounts = {};
    
    orders.forEach(order => {
      if (order.adminId === adminId && order.status === 'delivered') {
        order.items.forEach(item => {
          itemCounts[item.id] = (itemCounts[item.id] || 0) + item.quantity;
        });
      }
    });
    
    const topItems = Object.entries(itemCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => menu.find(item => item.id === id))
      .filter(Boolean);
    
    res.json(topItems);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================
// ORDER ROUTES
// ====================

// Create Order
app.post('/api/orders', async (req, res) => {
  try {
    const { userId, items, totalAmount, paymentMethod, adminId, orderType, scheduledTime } = req.body;
    
    const orderId = await generateOrderID();
    const orderOTP = generate4DigitOTP();
    
    const order = {
      id: uuidv4(),
      orderId,
      userId,
      adminId,
      items,
      totalAmount,
      paymentMethod,
      orderType: orderType || 'instant', // instant or preorder
      scheduledTime: scheduledTime || null,
      status: 'pending',
      otp: orderOTP,
      createdAt: new Date().toISOString(),
      pickup: 'Canteen Pickup'
    };
    
    const orders = await readFromJSON('orders.json');
    orders.push(order);
    await saveToJSON('orders.json', orders);
    await saveToDynamoDB(process.env.ORDERS_TABLE, order);
    
    const users = await readFromJSON('users.json');
    const user = users.find(u => u.id === userId);
    
    // Send order confirmation email
    await sendEmail(user.email, `Order Placed: ${orderId}`, `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px; border-radius: 10px;">
        <h2 style="color: white; text-align: center;">✅ Order Placed Successfully!</h2>
        <div style="background: white; padding: 30px; border-radius: 10px; margin-top: 20px;">
          <h3 style="color: #667eea;">Order ID: ${orderId}</h3>
          <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 5px 0;"><strong>OTP:</strong> <span style="font-size: 24px; color: #667eea; font-weight: bold;">${orderOTP}</span></p>
            <p style="margin: 5px 0;"><strong>Total Amount:</strong> ₹${totalAmount}</p>
            <p style="margin: 5px 0;"><strong>Payment Method:</strong> ${paymentMethod}</p>
            ${orderType === 'preorder' ? `<p style="margin: 5px 0;"><strong>Scheduled Time:</strong> ${scheduledTime}</p>` : ''}
          </div>
          <p style="color: #64748b; font-size: 14px;">Present this OTP when collecting your order.</p>
        </div>
      </div>
    `);
    
    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Orders
app.get('/api/orders', async (req, res) => {
  try {
    const { userId, adminId, status } = req.query;
    let orders = await readFromJSON('orders.json');
    
    if (userId) orders = orders.filter(o => o.userId === userId);
    if (adminId) orders = orders.filter(o => o.adminId === adminId);
    if (status) orders = orders.filter(o => o.status === status);
    
    // Get user details for each order
    const users = await readFromJSON('users.json');
    orders = orders.map(order => {
      const user = users.find(u => u.id === order.userId);
      return {
        ...order,
        userName: user?.name || 'Unknown',
        userPhone: user?.phone || 'N/A'
      };
    });
    
    res.json(orders.reverse());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Order Status
app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    const orders = await readFromJSON('orders.json');
    const order = orders.find(o => o.id === id);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    order.status = status;
    order.updatedAt = new Date().toISOString();
    
    await saveToJSON('orders.json', orders);
    await saveToDynamoDB(process.env.ORDERS_TABLE, order);
    
    // Send notification to student
    const users = await readFromJSON('users.json');
    const user = users.find(u => u.id === order.userId);
    
    if (user && user.preferences?.notifications) {
      let statusMessage = '';
      switch(status) {
        case 'confirmed':
          statusMessage = 'Your order has been confirmed and is being prepared.';
          break;
        case 'preparing':
          statusMessage = 'Your order is being prepared.';
          break;
        case 'ready':
          statusMessage = 'Your order is ready for pickup!';
          break;
        case 'delivered':
          statusMessage = 'Your order has been completed. Enjoy your meal!';
          break;
      }
      
      await sendEmail(user.email, `Order ${order.orderId} - ${status.toUpperCase()}`, `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px; border-radius: 10px;">
          <h2 style="color: white; text-align: center;">📦 Order Update</h2>
          <div style="background: white; padding: 30px; border-radius: 10px; margin-top: 20px;">
            <h3 style="color: #667eea;">Order ID: ${order.orderId}</h3>
            <p style="font-size: 18px; color: #10b981;">${statusMessage}</p>
            ${status === 'ready' ? `<p style="background: #fef3c7; padding: 15px; border-radius: 8px; border-left: 4px solid #f59e0b;"><strong>OTP: ${order.otp}</strong><br>Present this OTP when collecting your order.</p>` : ''}
          </div>
        </div>
      `);
    }
    
    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel Order
app.patch('/api/orders/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    
    const orders = await readFromJSON('orders.json');
    const order = orders.find(o => o.id === id);
    
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    if (!['pending', 'confirmed'].includes(order.status)) {
      return res.status(400).json({ error: 'Order cannot be cancelled at this stage' });
    }
    
    order.status = 'cancelled';
    order.updatedAt = new Date().toISOString();
    
    await saveToJSON('orders.json', orders);
    await saveToDynamoDB(process.env.ORDERS_TABLE, order);
    
    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================
// ANALYTICS ROUTES
// ====================

// Get Analytics
app.get('/api/analytics/:adminId', async (req, res) => {
  try {
    const { adminId } = req.params;
    const orders = await readFromJSON('orders.json');
    const menu = await readFromJSON('menu.json');
    
    const adminOrders = orders.filter(o => o.adminId === adminId);
    
    const totalRevenue = adminOrders
      .filter(o => o.status === 'delivered')
      .reduce((sum, o) => sum + o.totalAmount, 0);
    
    const totalOrders = adminOrders.length;
    
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    
    // Revenue by day (last 7 days)
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toDateString();
      
      const dayRevenue = adminOrders
        .filter(o => o.status === 'delivered' && new Date(o.createdAt).toDateString() === dateStr)
        .reduce((sum, o) => sum + o.totalAmount, 0);
      
      last7Days.push({
        date: dateStr,
        revenue: dayRevenue
      });
    }
    
    // Top 5 selling items
    const itemCounts = {};
    adminOrders.forEach(order => {
      if (order.status === 'delivered') {
        order.items.forEach(item => {
          if (!itemCounts[item.id]) {
            itemCounts[item.id] = { count: 0, revenue: 0 };
          }
          itemCounts[item.id].count += item.quantity;
          itemCounts[item.id].revenue += item.price * item.quantity;
        });
      }
    });
    
    const topItems = Object.entries(itemCounts)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([id, data]) => {
        const menuItem = menu.find(item => item.id === id);
        return {
          ...menuItem,
          soldCount: data.count,
          revenue: data.revenue
        };
      });
    
    res.json({
      totalRevenue,
      totalOrders,
      avgOrderValue,
      last7Days,
      topItems
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================
// RAZORPAY ROUTES
// ====================

// Create Razorpay Order
app.post('/api/razorpay/create-order', async (req, res) => {
  try {
    const { amount } = req.body;
    
    const options = {
      amount: amount * 100, // Convert to paise
      currency: 'INR',
      receipt: 'order_' + Date.now()
    };
    
    const order = await razorpay.orders.create(options);
    
    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      key: process.env.RAZORPAY_KEY_ID
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================
// SETTINGS ROUTES
// ====================

// Get Shop Settings
app.get('/api/settings/:adminId', async (req, res) => {
  try {
    const { adminId } = req.params;
    const settings = await readFromJSON('settings.json');
    
    let shopSettings = settings.find(s => s.adminId === adminId);
    
    if (!shopSettings) {
      shopSettings = {
        id: uuidv4(),
        adminId,
        isOpen: true,
        openTime: '08:00',
        closeTime: '20:00',
        darkMode: false
      };
      settings.push(shopSettings);
      await saveToJSON('settings.json', settings);
    }
    
    res.json(shopSettings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Shop Settings
app.put('/api/settings/:adminId', async (req, res) => {
  try {
    const { adminId } = req.params;
    const updates = req.body;
    
    const settings = await readFromJSON('settings.json');
    let shopSettings = settings.find(s => s.adminId === adminId);
    
    if (!shopSettings) {
      shopSettings = { id: uuidv4(), adminId };
      settings.push(shopSettings);
    }
    
    Object.assign(shopSettings, updates);
    await saveToJSON('settings.json', settings);
    await saveToDynamoDB(process.env.SETTINGS_TABLE, shopSettings);
    
    res.json({ success: true, settings: shopSettings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====================
// USER PROFILE ROUTES
// ====================

// Get User Profile
app.get('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const users = await readFromJSON('users.json');
    const user = users.find(u => u.id === id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ ...user, password: undefined });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update User Profile
app.put('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const users = await readFromJSON('users.json');
    const user = users.find(u => u.id === id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Don't allow password or studentId updates through this route
    delete updates.password;
    delete updates.studentId;
    
    Object.assign(user, updates);
    await saveToJSON('users.json', users);
    await saveToDynamoDB(process.env.USERS_TABLE, user);
    
    res.json({ success: true, user: { ...user, password: undefined } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Initialize on startup
initializeDataFiles();

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}/index.html`);
  console.log(`📁 Data directory: ${DATA_DIR}`);
  console.log(`☁️  AWS DynamoDB configured`);
  console.log(`💳 Razorpay configured (Test Mode)`);
  console.log(`📧 Email service ready\n`);
});
