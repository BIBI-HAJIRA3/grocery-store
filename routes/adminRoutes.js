const cors = require('cors');
app.use(cors());

const express = require('express');
const router = express.Router();
const Product = require('../models/Product');

// Delete a product
router.delete('/product/:id', async (req, res) => {
    try {
        const deleted = await Product.findByIdAndDelete(req.params.id);
        if (!deleted) return res.status(404).json({ message: 'Product not found' });
        res.json({ message: 'Product deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

module.exports = router;
