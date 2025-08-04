import jwt from "jsonwebtoken";
import User from "../models/User.js";

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const user = await User.findById(decoded.id).select('-password');
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      req.user = user;
      req.user.id = decoded.id; // ✅ ensure availability

      console.log('✅ Authenticated:', req.user.email);
      next();
    } catch (err) {
      console.log('❌ Token failed:', err.message);
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }
  } else {
    console.log('❌ No token in header');
    res.status(401).json({ message: 'Not authorized, no token' });
  }
};

export default protect;
