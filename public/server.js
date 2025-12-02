// server.js
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();


// Cloudinary: used to store product images so your client never deals with URLs.
// Values MUST come from environment variables (set these in Render dashboard).
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,   // 
  api_key: process.env.CLOUDINARY_API_KEY,         // 
  api_secret: process.env.CLOUDINARY_API_SECRET    // 
  // Do NOT hard‑code the secret in code; keep it only in env vars.
});

const app = express();


// --------------------
// Config
// --------------------
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/grocery';
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_change_in_prod';
const PORT = process.env.PORT || 5000;
const APP_VERSION = '1';

// YOUR STORE LOCATION (set these to your real lat/lng)
const STORE_LOCATION = {
  lat: 13.877446,
  lng: 75.735827
};
const MAX_KM = 8; // 6 km delivery radius

// --------------------
// Middleware
// --------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

// --------------------
// Multer / uploads
// --------------------
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });
app.use('/uploads', express.static(uploadDir));

// --------------------
// Mongo
// --------------------
mongoose.connect(MONGO_URI)
  .then(() => console.log('✓ MongoDB connected'))
  .catch(err => console.log('✗ MongoDB error:', err));

// --------------------
// Schemas
// --------------------
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true, required: true },
  passwordHash: { type: String, required: true },
  phone: String,
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  cart: [{
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    quantity: { type: Number, default: 1 }
  }],
  addresses: [{
    label: String,
    line1: String,
    line2: String,
    city: String,
    pincode: String,
    isDefault: { type: Boolean, default: false }
  }],
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  price: { type: Number, required: true },
  category: { type: String },
  image: String,                // optional
  unit: { type: String, default: '' }, // e.g. "25 kg packet"
  createdAt: { type: Date, default: Date.now }
});
const Product = mongoose.model('Product', productSchema);

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  items: [{
    productId: mongoose.Schema.Types.ObjectId,
    name: String,
    price: Number,
    quantity: Number
  }],
  total: Number,
  deliveryAddress: {
    name: String,
    phone: String,
    line1: String,
    line2: String,
    city: String,
    pincode: String,
    lat: Number,
    lng: Number,
    notes:String
  },
  status: { type: String, enum: ['pending', 'completed', 'cancelled'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

// --------------------
// Auth helpers
// --------------------
const authMiddleware = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const adminMiddleware = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
};

// --------------------
// Distance helper (Haversine)
// --------------------
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// --------------------
// Seed
// --------------------
async function seed() {
  try {
    const prodCount = await Product.countDocuments();
    if (prodCount === 0) {
      await Product.insertMany([
        { name: 'Rice', category: 'Essentials', price: 90, unit: '1 kg packet', description: 'Basmati rice' },
        { name: 'Milk', category: 'Dairy', price: 60, unit: '1 litre', description: 'Fresh milk' }
      ]);
      console.log('✓ Seeded sample products');
    }
    const adminExists = await User.countDocuments({ role: 'admin' });
    if (!adminExists) {
      const hash = await bcrypt.hash('admin123', 10);
      await User.create({ name: 'Admin', email: 'admin@grocery.com', passwordHash: hash, role: 'admin' });
      console.log('✓ Created default admin: admin@grocery.com / admin123');
    }
  } catch (e) {
    console.error('Seed error:', e);
  }
}
seed();

// --------------------
// SSE
// --------------------
const sseClients = [];
function broadcastNewOrder(orderObj) {
  const payload = `data: ${JSON.stringify(orderObj)}\n\n`;
  sseClients.forEach(c => { try { c.res.write(payload); } catch {} });
}

// --------------------
// Routes: basic
// --------------------
// --------------------
// Routes: basic
// --------------------
// 2‑second welcome page, then go to /user
app.get('/', (req, res) => {
  res.send(`<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>Welcome</title>
  <style>
    body{
      margin:0;display:flex;align-items:center;justify-content:center;
      height:100vh;font-family:Arial,Helvetica,sans-serif;
      background:#f5f7fb;color:#008080; /* teal text */
    }
    .box{text-align:center;}
    .logo{
      font-size:52px;  /* bigger */
      font-weight:700;
      margin-bottom:8px;
      color:#008080;   /* teal for the main heading */
    }
    .sub{font-size:18px;color:#444;}
  </style>
</head>
<body>
  <div class="box">
    <div class="logo">Welcome to Grocery Store</div>
    <div class="sub">Loading your store...</div>
  </div>
  <script>
    setTimeout(function(){
      window.location.href = '/user';
    }, 2000);
  </script>
</body></html>`);
});


// --- Admin login page ---
app.get('/admin', (req, res) => {
  res.send(`<!doctype html>
<html><head>
  <meta charset="utf-8"><title>Admin Login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">

  <style>
    body{font-family:Arial,Helvetica,sans-serif;padding:18px;max-width:400px;margin:auto;background:#f5f7fb;}
    h1{text-align:center;color:#009688;}
    input,button{display:block;width:100%;margin:8px 0;padding:8px;border-radius:4px;border:1px solid #ccc;}
    button{cursor:pointer;border:1px solid #009688;background:#009688;color:#fff;font-weight:600;}
    button:hover{background:#00796b;}
    #error{color:red;margin-top:8px;}
  </style>
  
</head>
<body>
  <h1>Admin Login</h1>
  <input id="email" placeholder="Admin email" type="email">
  <input id="password" placeholder="Password" type="password">
  <button onclick="loginAdmin()">Login</button>
  <div id="error"></div>
<script>
async function loginAdmin() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value.trim();
  if (!email || !password) {
    document.getElementById('error').textContent = 'Enter email and password';
    return;
  }
  try {
    const res = await fetch('/api/auth/login', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email,password})
    });
    const data = await res.json();
    if (!res.ok) { document.getElementById('error').textContent = data.error || 'Login failed'; return; }
    if (data.user.role !== 'admin') { document.getElementById('error').textContent = 'Not an admin account'; return; }
    localStorage.setItem('adminToken', data.token);
    window.location.href='/admin/dashboard';
  } catch(e){ document.getElementById('error').textContent='Error logging in'; }
}
</script>
</body></html>`);
});

// --- Admin dashboard (orders + products + profile) ---
app.get('/admin/dashboard', (req, res) => {
  res.send(`<!doctype html>
<html><head>
  <meta charset="utf-8"><title>Admin Panel</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">

  <style>
    body{font-family:Arial,Helvetica,sans-serif;padding:16px;background:#f5f7fb;}
    h1{color:#009688;margin-top:0;}
    table{width:100%;border-collapse:collapse;margin-top:12px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);}
    th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:14px;}
    th{background:#f5f5f5;}
    .controls{display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap;}
    button{cursor:pointer;border-radius:4px;border:1px solid #009688;background:#009688;color:#fff;font-weight:600;padding:6px 10px;}
    button:hover{background:#00796b;}

    header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;}
    .card{background:#fff;border-radius:8px;padding:12px;box-shadow:0 1px 3px rgba(0,0,0,0.1);margin-top:12px;}
    input{padding:6px;border-radius:4px;border:1px solid #ccc;}
    label{display:block;margin-top:6px;}
   
  .table-wrap{
  width:100%;
  overflow-x:auto;
}
table{
  width:100%;
  border-collapse:collapse;
  margin-top:12px;
  background:#fff;
  border-radius:8px;
  overflow:hidden;
  box-shadow:0 1px 3px rgba(0,0,0,0.1);
}
th,td{
  border:1px solid #ddd;
  padding:8px;
  text-align:left;
  font-size:13px;
}
th{background:#f5f5f5;}

@media (max-width:600px){
  body{padding:10px;}
  th,td{font-size:12px;padding:6px;}
  header h1{font-size:18px;}
}

}

.form-grid{
  display:block;
}
.form-field{
  margin-bottom:8px;
}
.form-field label{
  display:block;
  font-size:13px;
  margin-bottom:2px;
}
.form-field input{
  width:100%;
  box-sizing:border-box;
}

    .account-card{
      max-width:420px;
      margin:16px auto;
      padding:12px;
      border-radius:10px;
      background:#ffffff;
      box-shadow:0 1px 3px rgba(0,0,0,0.08);
      border:1px solid #e0e0e0;
    }
    .account-card h3{
      margin:0 0 8px;
      font-size:18px;
    }
    .account-form-group{
      margin-bottom:10px;
    }
    .account-form-group label{
      display:block;
      font-size:13px;
      margin-bottom:3px;
    }
    .account-form-group input{
      width:100%;
      box-sizing:border-box;
      padding:8px;
      border-radius:4px;
      border:1px solid #ccc;
    }
    .account-actions{
      margin-top:10px;
      display:flex;
      gap:8px;
    }
    .account-actions button{
      flex:1;
    }



  </style>
</head>
<body>
<header>
  <h1>Admin Panel</h1>
  <div>
    <button onclick="window.location.href='/user?v=${APP_VERSION}'" style="margin-right:8px;">User View</button>
    <button onclick="logout()">Logout</button>
  </div>
</header>

<div class="controls">
  <button onclick="fetchOrders()">Refresh orders</button>
  <span id="count">0 orders</span>
</div>

<div class="table-wrap">
  <table aria-live="polite">
    <thead><tr>
      <th>User</th><th>Contact</th><th>Address</th><th>Notes</th><th>Items</th>
      <th>Total</th><th>Time</th><th>Status</th><th>Actions</th>
    </tr></thead>
    <tbody id="ordersTbody"></tbody>
  </table>
</div>


<div class="card">
  <h2>Products</h2>
  <h3>Add product</h3>
<input id="prodId" type="hidden">

<div class="form-grid">
  <div class="form-field">
    <label for="prodName">Name</label>
    <input id="prodName">
  </div>
  <div class="form-field">
    <label for="prodPrice">Price</label>
    <input id="prodPrice" type="number" step="0.01">
  </div>
  <div class="form-field">
    <label for="prodCategory">Category(Optional)</label>
    <input id="prodCategory">
  </div>
  <div class="form-field">
    <label for="prodUnit">Quantity / Unit (e.g. 25 kg packet)</label>
    <input id="prodUnit">
  </div>
  <div class="form-field">
    <label for="prodDesc">Description</label>
    <input id="prodDesc">
  </div>
  <div class="form-field">
    <label for="prodImage">Image (optional)</label>
    <input id="prodImage" type="file" accept="image/*">
  </div>
</div>

<button onclick="saveProduct()">Save product</button>
<button onclick="resetProductForm()">Clear form</button>
<div id="prodMsg" style="margin-top:6px;color:green;"></div>


  <h3 style="margin-top:16px;">All products</h3>
  <table style="width:100%;border-collapse:collapse;margin-top:8px;">
    <thead><tr>
      <th>Name</th><th>Category</th><th>Price</th><th>Unit</th><th>Image?</th><th>Actions</th>
    </tr></thead>
    <tbody id="prodTbody"></tbody>
  </table>
</div>

<div class="account-card">
  <h2>Admin account settings</h2>

  <div class="account-form-group">
    <label for="newEmail">New email</label>
    <input id="newEmail" type="email">
  </div>

  <div class="account-form-group">
    <label for="currentPassword">Current password</label>
    <input id="currentPassword" type="password">
  </div>

  <div class="account-form-group">
    <label for="newPassword">New password</label>
    <input id="newPassword" type="password">
  </div>

  <div class="account-actions">
    <button onclick="updateProfile()">Update email / password</button>
  </div>

  <div id="profileMsg" style="margin-top:6px;color:green;"></div>
</div>


<script>
function getToken(){return localStorage.getItem('adminToken')||'';}
function ensureToken(){const t=getToken();if(!t){window.location.href='/admin';return null;}return t;}
function logout(){localStorage.removeItem('adminToken');window.location.href='/admin';}
function escapeHtml(s){return (s||'').toString().replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}

async function fetchOrders(){
  const token=ensureToken();if(!token)return;
  const res=await fetch('/api/admin/orders',{headers:{Authorization:'Bearer '+token}});
  if(!res.ok){document.getElementById('ordersTbody').innerHTML='<tr><td colspan="8">Unauthorized</td></tr>';return;}
  const list=await res.json();renderOrders(list);
}
async function changeStatus(id,status){
  const token=ensureToken();if(!token)return;
  const res=await fetch('/api/admin/orders/'+id+'/status',{
    method:'PUT',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
    body:JSON.stringify({status})
  });
  if(res.ok)fetchOrders();
}
async function deleteOrder(id){
  const token=ensureToken();if(!token)return;
  if(!confirm('Delete this order?'))return;
  const res=await fetch('/api/admin/orders/'+id,{method:'DELETE',headers:{Authorization:'Bearer '+token}});
  if(res.ok)fetchOrders();
}
function renderOrders(list){
  const tbody=document.getElementById('ordersTbody');tbody.innerHTML='';
  list.forEach(o=>{
    const items = o.items.map(i => i.name + ' x ' + i.quantity).join(', ');
const address = o.deliveryAddress ? (o.deliveryAddress.line1 + ', ' + o.deliveryAddress.city) : '-';
const notes = o.deliveryAddress?.notes || '';
const tr = document.createElement('tr');
const status = o.status || 'pending';
tr.innerHTML =
  '<td>'+escapeHtml(o.userId?.name||'N/A')+'</td>'+
  '<td>'+escapeHtml(o.deliveryAddress?.phone||'')+'</td>'+
  '<td>'+escapeHtml(address)+'</td>'+
  '<td>'+escapeHtml(notes)+'</td>'+
  '<td>'+escapeHtml(items)+'</td>'+
  '<td>₹'+(o.total||0)+'</td>'+
  '<td>'+new Date(o.createdAt).toLocaleString()+'</td>'+
  '<td>'+escapeHtml(status)+'</td>'+
  '<td></td>';

    const actionsTd=tr.lastChild;
    if(status!=='completed'){
      const cBtn=document.createElement('button');cBtn.textContent='Mark completed';
      cBtn.onclick=()=>changeStatus(o._id,'completed');
      actionsTd.appendChild(cBtn);
    }
    if(status==='completed'||status==='cancelled'){
      const dBtn=document.createElement('button');dBtn.textContent='Delete';dBtn.style.marginLeft='4px';
      dBtn.onclick=()=>deleteOrder(o._id);
      actionsTd.appendChild(dBtn);
    }
    tbody.appendChild(tr);
  });
  document.getElementById('count').textContent=list.length+' orders';
}

async function updateProfile(){
  const token=ensureToken();if(!token)return;
  const email=document.getElementById('newEmail').value.trim();
  const currentPassword=document.getElementById('currentPassword').value.trim();
  const newPassword=document.getElementById('newPassword').value.trim();
  if(!currentPassword){document.getElementById('profileMsg').style.color='red';document.getElementById('profileMsg').textContent='Enter current password';return;}
  const body={currentPassword};if(email)body.email=email;if(newPassword)body.newPassword=newPassword;
  const res=await fetch('/api/auth/profile',{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body)});
  const data=await res.json();
  if(!res.ok){document.getElementById('profileMsg').style.color='red';document.getElementById('profileMsg').textContent=data.error||'Update failed';}
  else{document.getElementById('profileMsg').style.color='green';document.getElementById('profileMsg').textContent='Updated successfully';}
}

// Products
async function fetchProducts(){
  const token=ensureToken();if(!token)return;
  const res=await fetch('/api/products',{headers:{Authorization:'Bearer '+token}});
  if(!res.ok){document.getElementById('prodTbody').innerHTML='<tr><td colspan="6">Failed to load products</td></tr>';return;}
  const list=await res.json();renderProducts(list);
}
function renderProducts(list){
  const tbody = document.getElementById('prodTbody');
  tbody.innerHTML = '';
  list.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>'+escapeHtml(p.name)+'</td>'+
      '<td>'+escapeHtml(p.category)+'</td>'+
      '<td>₹'+(p.price || 0)+'</td>'+
      '<td>'+escapeHtml(p.unit || '')+'</td>'+
      '<td>'+(p.image ? 'Yes' : 'No')+'</td>'+
      '<td></td>';
    const actionsTd = tr.lastChild;
    const dBtn = document.createElement('button');
    dBtn.textContent = 'Delete';
    dBtn.onclick = () => deleteProduct(p._id);
    actionsTd.appendChild(dBtn);
    tbody.appendChild(tr);
  });
}

function resetProductForm(){
  document.getElementById('prodId').value='';
  document.getElementById('prodName').value='';
  document.getElementById('prodPrice').value='';
  document.getElementById('prodCategory').value='';
  document.getElementById('prodUnit').value='';
  document.getElementById('prodDesc').value='';
  document.getElementById('prodImage').value='';
  document.getElementById('prodMsg').textContent='';
}
async function loadProductIntoForm(id){
  const token=ensureToken();if(!token)return;
  const res=await fetch('/api/products/'+id,{headers:{Authorization:'Bearer '+token}});
  if(!res.ok)return;
  const p=await res.json();
  document.getElementById('prodId').value=p._id;
  document.getElementById('prodName').value=p.name||'';
  document.getElementById('prodPrice').value=p.price||'';
  document.getElementById('prodCategory').value=p.category||'';
  document.getElementById('prodUnit').value=p.unit||'';
  document.getElementById('prodDesc').value=p.description||'';
  document.getElementById('prodMsg').style.color='green';
  document.getElementById('prodMsg').textContent='Loaded product for editing';
}
async function saveProduct(){
  const token=ensureToken();if(!token)return;
  const id=document.getElementById('prodId').value.trim();
  const name=document.getElementById('prodName').value.trim();
  const price=document.getElementById('prodPrice').value.trim();
  const category=document.getElementById('prodCategory').value.trim();
  const unit=document.getElementById('prodUnit').value.trim();
  const description=document.getElementById('prodDesc').value.trim();
  const imageInput=document.getElementById('prodImage');
  if(!name||!price){
    document.getElementById('prodMsg').style.color='red';
    document.getElementById('prodMsg').textContent='Name and price are required';
    return;
  }
  const fd=new FormData();
  fd.append('name',name);
  fd.append('price',price);
  fd.append('category',category);
  fd.append('unit',unit);
  fd.append('description',description);
  if(imageInput.files[0])fd.append('image',imageInput.files[0]);
  const url=id?'/api/admin/products/'+id:'/api/admin/products';
  const method=id?'PUT':'POST';
  const res=await fetch(url,{method,headers:{Authorization:'Bearer '+token},body:fd});
  const data=await res.json();
  if(!res.ok){
    document.getElementById('prodMsg').style.color='red';
    document.getElementById('prodMsg').textContent=data.error||'Save failed';
  }else{
    document.getElementById('prodMsg').style.color='green';
    document.getElementById('prodMsg').textContent='Product saved';
    resetProductForm();
    fetchProducts();
  }
}
async function deleteProduct(id){
  const token=ensureToken();if(!token)return;
  if(!confirm('Delete this product?'))return;
  const res=await fetch('/api/admin/products/'+id,{method:'DELETE',headers:{Authorization:'Bearer '+token}});
  if(res.ok)fetchProducts();
}

// Initial load
ensureToken();
fetchOrders();
fetchProducts();
</script>
</body></html>`);
});

// --------------------
// User page
// --------------------
app.get('/user', (req, res) => {
  res.send(`<!doctype html>
<html><head>
  <meta charset="utf-8"><title>User — Grocery</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">

  <style>
  body{font-family:Arial,Helvetica,sans-serif;padding:18px;max-width:1100px;margin:auto;background:#f5f7fb;}
  header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;}
  .grid{
    display:grid;
    grid-template-columns:repeat(2,minmax(0,1fr));
    gap:14px;
    padding:4px 0;
  }

  .card{
    width:100%;
    min-height:190px;
    box-sizing:border-box;
    border:1px solid #ddd;
    padding:8px;
    border-radius:10px;
    background:#fff;
    box-shadow:0 1px 3px rgba(0,0,0,0.05);
    display:flex;
    flex-direction:column;
    justify-content:space-between;
  }

  .card h4{
    margin:6px 0 4px;
    font-size:14px;
    font-weight:600;
  }

  img{
    width:100%;
    height:90px;
    object-fit:cover;
    background:#f3f3f3;
    border-radius:6px;
  }

  /* Global form elements */
  input,select,button,textarea{
    display:block;
    margin:8px 0;
    padding:8px;
    width:100%;
    max-width:360px;
    border-radius:4px;
    border:1px solid #ccc;
    box-sizing:border-box;
  }

  /* Override just for inputs inside product cards (e.g. quantity) */
  .card input{
  width:100%;
  max-width:none;
  box-sizing:border-box;
}


  button{
    cursor:pointer;
    border-radius:4px;
    border:1px solid #009688;
    background:#009688;
    color:#fff;
    font-weight:600;
  }
  button:hover{
    background:#00796b;
  }

  #cartBox{
    border-top:2px solid #ccc;
    padding-top:12px;
    margin-top:12px;
    background:#ffffff;
    border-radius:8px;
    padding:12px;
    box-shadow:0 1px 3px rgba(0,0,0,0.05)
  }
</style>

  
</head>
<body>
<header>
  <h1>Grocery Store</h1>
  <div>
  <!-- Call button: change number later -->
  <a href="tel:+917892469393"
     style="margin-right:8px;text-decoration:none;display:inline-flex;align-items:center;
            justify-content:center;width:40px;height:40px;border-radius:50%;
            background:#008080;color:#fff;font-size:20px;border:1px solid #0a7a07;">
    📞
  </a>
  <button onclick="window.location.href='/user?v=${APP_VERSION}'" style="margin-right:8px;">Home</button>
  <button onclick="window.location.href='/admin'">Admin</button>
</div>

</header>

<div>
  <label>Search:
    <input id="q" placeholder="search name or category">
  </label>
  <button onclick="loadProducts()">Search</button>
</div>

<h2>Products</h2>
<div id="productList" class="grid">Loading...</div>

<div id="cartBox">
  <h2>Your Cart</h2>
  <div id="cartList">Cart empty</div>

<h3>Delivery details</h3>
<input id="name" placeholder="Your name">
<input id="phone" placeholder="Phone">
<input id="line1" placeholder="Address line 1">
<input id="city" placeholder="City">
<input id="pincode" placeholder="Pincode">
<textarea id="notes" rows="3" placeholder="Any special requests (optional)"></textarea>
<button id="checkoutBtn">Place Order</button>
<div id="status" style="color:green;margin-top:8px"></div>
  
</div>

<script>
  let products=[];
  let cart={};
    // Load previously saved delivery details from this device (localStorage).
  function loadSavedDetails(){
    try{
      const raw=localStorage.getItem('userDetails');
      if(!raw)return;
      const d=JSON.parse(raw);
      if(d.name)document.getElementById('name').value=d.name;
      if(d.phone)document.getElementById('phone').value=d.phone;
      if(d.line1)document.getElementById('line1').value=d.line1;
      if(d.city)document.getElementById('city').value=d.city;
      if(d.pincode)document.getElementById('pincode').value=d.pincode;
      // notes is always optional, so do NOT prefill it; user can type it fresh each order.
    }catch(e){
      console.warn('Failed to load saved user details',e);
    }
  }

  // Save delivery details (except notes) to this device so user doesn’t retype next time.
  function saveDetailsForNextTime(){
    try{
      const d={
        name:document.getElementById('name').value.trim(),
        phone:document.getElementById('phone').value.trim(),
        line1:document.getElementById('line1').value.trim(),
        city:document.getElementById('city').value.trim(),
        pincode:document.getElementById('pincode').value.trim()
      };
      localStorage.setItem('userDetails',JSON.stringify(d));
    }catch(e){
      console.warn('Failed to save user details',e);
    }
  }

  function escapeHtml(s){return (s||'').toString().replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}

  async function loadProducts(){
    const q=document.getElementById('q').value.trim();
    const url='/api/products'+(q?'?search='+encodeURIComponent(q):'');
    const res=await fetch(url);
    products=await res.json();
    const list=document.getElementById('productList');list.innerHTML='';
    products.forEach(p=>{
      const card=document.createElement('div');card.className='card';
      card.innerHTML=
  '<img src="'+(p.image||'')+'">'+
  '<h4>'+escapeHtml(p.name)+'</h4>'+
  '<div>₹'+p.price+'</div>'+
  '<div>'+escapeHtml(p.category)+'</div>'+
  '<div>'+escapeHtml(p.unit||'')+'</div>'+
  '<div style="font-size:12px;color:#555;">'+escapeHtml(p.description||'')+'</div>'+
  '<input type="number" min="1" value="1" id="qty_'+p._id+'">'+
  '<button onclick="addToCart(\\''+p._id+'\\')">Add to cart</button>';

      list.appendChild(card);
    });
  }

  function renderCart(){
    const el=document.getElementById('cartList');el.innerHTML='';
    const keys=Object.keys(cart);
    if(!keys.length){el.innerHTML='Cart empty';return;}
    let total=0;
    keys.forEach(pid=>{
      const p=products.find(x=>x._id===pid)||{name:'Product',price:0};
      const qty=cart[pid];
      total+=p.price*qty;
      const div=document.createElement('div');
      div.innerHTML=
        escapeHtml(p.name)+' × '+qty+' — ₹'+(p.price*qty)+
        ' <button onclick="changeQty(\\''+pid+'\\',-1)">-</button>'+
        ' <button onclick="changeQty(\\''+pid+'\\',1)">+</button>'+
        ' <button onclick="removeItem(\\''+pid+'\\')">Remove</button>';
      el.appendChild(div);
    });
    const tot=document.createElement('div');tot.innerHTML='<b>Total: ₹'+total+'</b>';
    el.appendChild(tot);
  }

  function addToCart(id){
    const qEl=document.getElementById('qty_'+id);
    const qty=qEl?parseInt(qEl.value)||1:1;
    cart[id]=(cart[id]||0)+qty;
    renderCart();
  }
  function changeQty(id,delta){
    cart[id]=(cart[id]||0)+delta;
    if(cart[id]<=0)delete cart[id];
    renderCart();
  }
  function removeItem(id){delete cart[id];renderCart();}

  
document.getElementById('checkoutBtn').addEventListener('click', async ()=>{
  const name = document.getElementById('name').value.trim();
  const phone = document.getElementById('phone').value.trim();
  const line1 = document.getElementById('line1').value.trim();
  const city = document.getElementById('city').value.trim();
  const pincode = document.getElementById('pincode').value.trim();
  const notes = document.getElementById('notes').value.trim();


  if (!name || !phone || !line1 || !city || !pincode) {
    return alert('Fill delivery details');
  }

  const items = Object.keys(cart).map(pid => {
    const p = products.find(x => x._id === pid);
    return { productId: pid, name: p.name, price: p.price, quantity: cart[pid] };
  });
  if (!items.length) return alert('Cart empty');

  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);
  const payload = {
    items,
    total,
    deliveryAddress: { name, phone, line1, city, pincode,notes}
  };

  const res = await fetch('/api/placeGuestOrder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (res.ok) {
    saveDetailsForNextTime();
    document.getElementById('status').textContent = 'Order placed — admin will be notified';
    cart = {};
    renderCart();
  } else {
    alert(data.error || 'Failed to place order');
  }
});

  loadProducts();
  renderCart();
  loadSavedDetails(); // Prefill name/phone/address if this device has them saved.
 
</script>
</body></html>`);
});

// --------------------
// Products API
// --------------------
app.get('/api/products', async (req, res) => {
  try {
    const { category, search } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (search) filter.name = { $regex: search, $options: 'i' };
    const products = await Product.find(filter).sort({ name: 1 });
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const p = await Product.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(p);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------
// Auth
// --------------------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email exists' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, passwordHash, phone });
    const token = jwt.sign({ id: user._id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user._id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/auth/profile', authMiddleware, async (req, res) => {
  try {
    const { email, currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword || '', user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

    if (email) user.email = email;
    if (newPassword) user.passwordHash = await bcrypt.hash(newPassword, 10);

    await user.save();
    res.json({ success: true, email: user.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-passwordHash');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/me', authMiddleware, async (req, res) => {
  try {
    const { name, phone, addresses } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (name !== undefined) user.name = name;
    if (phone !== undefined) user.phone = phone;
    if (Array.isArray(addresses)) user.addresses = addresses;

    await user.save();
    res.json({ success: true, user: { id: user._id, name: user.name, email: user.email, phone: user.phone, addresses: user.addresses } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// --------------------
// Guest order with 6km check
// --------------------
app.post('/api/placeGuestOrder', async (req, res) => {
  try {
    const { items, total, deliveryAddress } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'No items' });

    // Location no longer required; just store whatever comes
    const guest = await User.create({
      name: deliveryAddress?.name || 'Guest',
      email: `guest+${Date.now()}@local`,
      passwordHash: await bcrypt.hash(Math.random().toString(36).slice(2), 8),
      phone: deliveryAddress?.phone || ''
    });

    const order = await Order.create({
      userId: guest._id,
      items,
      total,
      deliveryAddress,
      status: 'pending'
    });

    broadcastNewOrder({
      id: order._id,
      userName: guest.name,
      deliveryAddress,
      items,
      total: order.total,
      createdAt: order.createdAt,
      status: order.status
    });

    res.status(201).json({ success: true, orderId: order._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


   

// --------------------
// Authenticated orders
// --------------------
app.post('/api/orders', authMiddleware, async (req, res) => {
  try {
    const { items, total, deliveryAddress } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'No items' });

    // No distance / lat-lng check now
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const order = await Order.create({
      userId: user._id,
      items,
      total,
      deliveryAddress,
      status: 'pending'
    });

    broadcastNewOrder({
      id: order._id,
      userName: user.name,
      deliveryAddress: order.deliveryAddress,
      items,
      total: order.total,
      createdAt: order.createdAt,
      status: order.status
    });

    res.status(201).json({ success: true, orderId: order._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


 

app.get('/api/orders/my', authMiddleware, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------------
// Admin orders & SSE
// --------------------
app.get('/api/admin/orders', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const list = await Order.find().populate('userId', 'name email phone').sort({ createdAt: -1 }).limit(500);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/orders/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await Order.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Optional SSE endpoint (dev)
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive'
  });
  res.write('\n');
  const clientId = Date.now() + Math.random();
  sseClients.push({ id: clientId, res });
  req.on('close', () => {
    const idx = sseClients.findIndex(c => c.id === clientId);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// --------------------
// Admin Product CRUD
// --------------------
// Admin: create product with optional image.
// Flow:
// 1) Multer reads the file from the admin's phone (field name: "image").
// 2) If there is a file, upload it to Cloudinary under folder "grocery/products".
// 3) Cloudinary returns a secure_url; store that URL in product.image.
// 4) If there is NO file, image will just be an empty string (text‑only product).
app.post('/api/admin/products', authMiddleware, adminMiddleware, upload.single('image'), async (req, res) => {
  try {
    const { name, description, price, category, unit } = req.body;

    // Basic validation so admin must at least set name + price.
    if (!name || !price) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    let imageUrl = '';

    // If admin selected an image, send it to Cloudinary.
    if (req.file) {
      // req.file.path is the temporary file path created by Multer.
      const uploadResult = await cloudinary.uploader.upload(req.file.path, {
        folder: 'grocery/products',    // You will see files under this folder in Cloudinary.
        use_filename: true,            // Keep original file name where possible.
        unique_filename: true          // Add random string to avoid collisions.
      });

      // secure_url is the HTTPS URL your app will use to display the image.
      imageUrl = uploadResult.secure_url || '';
    }

    const product = await Product.create({
      name,
      description,
      price: Number(price),
      category,
      unit,
      image: imageUrl
    });

    res.status(201).json(product);
  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: update product.
// If admin uploads a NEW image, send it to Cloudinary and replace product.image with the new URL.
// If no file is sent, keep the existing image URL untouched.
app.put('/api/admin/products/:id', authMiddleware, adminMiddleware, upload.single('image'), async (req, res) => {
  try {
    const { name, description, price, category, unit } = req.body;

    // Build an update object, but remove any undefined fields so we only change what was sent.
    const update = {
      name,
      description,
      price: price !== undefined && price !== '' ? Number(price) : undefined,
      category,
      unit: unit !== undefined ? unit : undefined
    };
    Object.keys(update).forEach(k => update[k] === undefined && delete update[k]);

    // If a new image file is provided, upload it to Cloudinary and set update.image.
    if (req.file) {
      const uploadResult = await cloudinary.uploader.upload(req.file.path, {
        folder: 'grocery/products',
        use_filename: true,
        unique_filename: true
      });
      update.image = uploadResult.secure_url || '';
    }

    const product = await Product.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!product) return res.status(404).json({ error: 'Product not found' });

    res.json(product);
  } catch (err) {
    console.error('Update product error:', err);
    res.status(500).json({ error: err.message });
  }
});



app.delete('/api/admin/products/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const p = await Product.findByIdAndDelete(req.params.id);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.put('/api/admin/orders/:id/status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { status: status || 'completed' },
      { new: true }
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --------------------
// Start server
// --------------------
app.listen(PORT, () => {
  console.log(`\n✓ Server running on http://localhost:${PORT}`);
  console.log(`✓ MongoDB: ${MONGO_URI}`);
  console.log(`Test admin login: admin@grocery.com / admin123`);
});


























