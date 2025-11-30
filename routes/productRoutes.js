const express = require('express');
const router = express.Router();
const Product = require('../models/Product');


const cors = require('cors');
app.use(cors());
// Get all products
router.get('/', async (req, res) => {
    try {
        const products = await Product.find();
        res.json(products);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Add a new product
router.post('/', async (req, res) => {
    try {
        const { name, price, category, image } = req.body;
        if (!name || !price || !category) {
            return res.status(400).json({ message: 'Name, price, and category are required' });
        }

        const product = new Product({ name, price, category, image });
        const savedProduct = await product.save();
        res.status(201).json(savedProduct);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
