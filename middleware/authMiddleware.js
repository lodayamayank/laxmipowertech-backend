import jwt from "jsonwebtoken";
import User from "../models/User.js";

const userCache = new Map(); // id -> { user, exp }
const TTL = 60_000;

const protect = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Not authorized, no token" });
  }

  try {
    const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET);

    let entry = userCache.get(decoded.id);
    if (!entry || entry.exp < Date.now()) {
      const user = await User.findById(decoded.id).select("-password").lean();
      if (!user) return res.status(404).json({ message: "User not found" });
      entry = { user, exp: Date.now() + TTL };
      userCache.set(decoded.id, entry);
    }

    req.user = { ...entry.user, id: decoded.id };
    next();
  } catch (err) {
    return res.status(401).json({ message: "Not authorized, token failed" });
  }
};

export default protect;
