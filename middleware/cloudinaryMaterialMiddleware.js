import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cloudinary from '../config/cloudinary.js';

// Configure multer for temporary storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tmpDir = 'tmp_uploads';
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    cb(null, tmpDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'material-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// File filter for images
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);
  
  if (mimetype && extname) {
    return cb(null, true);
  } else {
    cb(new Error('Only image files are allowed!'));
  }
};

// Multer upload configuration
export const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: fileFilter
});

/**
 * Upload a single file to Cloudinary
 * @param {String} filePath - Path to the temporary file
 * @param {String} folder - Cloudinary folder name (e.g., 'material-transfer/indents')
 * @param {String} publicId - Optional public ID for the file
 * @returns {Promise<Object>} - { url, publicId }
 */
export const uploadToCloudinary = async (filePath, folder = 'material-transfer', publicId = null) => {
  try {
    const options = {
      folder: folder,
      resource_type: 'auto'
    };
    
    if (publicId) {
      options.public_id = publicId;
    }
    
    const result = await cloudinary.uploader.upload(filePath, options);
    
    // Clean up temp file
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    return {
      url: result.secure_url,
      publicId: result.public_id
    };
  } catch (error) {
    // Clean up temp file on error
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    throw new Error(`Cloudinary upload failed: ${error.message}`);
  }
};

/**
 * Upload multiple files to Cloudinary
 * @param {Array} files - Array of file objects with path property
 * @param {String} folder - Cloudinary folder name
 * @returns {Promise<Array>} - Array of { url, publicId }
 */
export const uploadMultipleToCloudinary = async (files, folder = 'material-transfer') => {
  try {
    const uploadPromises = files.map(file => 
      uploadToCloudinary(file.path, folder)
    );
    return await Promise.all(uploadPromises);
  } catch (error) {
    throw new Error(`Multiple file upload failed: ${error.message}`);
  }
};

/**
 * Delete a file from Cloudinary using public_id
 * @param {String} publicId - The Cloudinary public_id of the file
 * @returns {Promise<Object>} - Deletion result
 */
export const deleteFromCloudinary = async (publicId) => {
  try {
    if (!publicId) {
      throw new Error('Public ID is required for deletion');
    }
    
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'image'
    });
    
    return result;
  } catch (error) {
    throw new Error(`Cloudinary deletion failed: ${error.message}`);
  }
};

/**
 * Delete multiple files from Cloudinary
 * @param {Array} publicIds - Array of Cloudinary public_ids
 * @returns {Promise<Array>} - Array of deletion results
 */
export const deleteMultipleFromCloudinary = async (publicIds) => {
  try {
    const deletePromises = publicIds
      .filter(id => id) // Filter out null/undefined values
      .map(id => deleteFromCloudinary(id));
    return await Promise.all(deletePromises);
  } catch (error) {
    throw new Error(`Multiple file deletion failed: ${error.message}`);
  }
};

/**
 * Extract public_id from Cloudinary URL
 * @param {String} url - Cloudinary URL
 * @returns {String} - Public ID
 */
export const extractPublicId = (url) => {
  if (!url || typeof url !== 'string') return null;
  
  try {
    // Extract public_id from Cloudinary URL
    // Example: https://res.cloudinary.com/demo/image/upload/v1234567890/material-transfer/file.jpg
    const parts = url.split('/');
    const uploadIndex = parts.indexOf('upload');
    
    if (uploadIndex === -1) return null;
    
    // Get everything after /upload/ (skip version if present)
    let publicIdParts = parts.slice(uploadIndex + 1);
    
    // Remove version number if present (starts with 'v' followed by numbers)
    if (publicIdParts[0] && publicIdParts[0].match(/^v\d+$/)) {
      publicIdParts = publicIdParts.slice(1);
    }
    
    // Join the remaining parts and remove extension
    const fullPath = publicIdParts.join('/');
    const publicId = fullPath.replace(/\.[^/.]+$/, ''); // Remove file extension
    
    return publicId;
  } catch (error) {
    console.error('Error extracting public_id:', error);
    return null;
  }
};

/**
 * Replace an existing image in Cloudinary
 * @param {String} oldPublicId - The public_id of the old image to delete
 * @param {String} newFilePath - Path to the new temporary file
 * @param {String} folder - Cloudinary folder name
 * @returns {Promise<Object>} - { url, publicId }
 */
export const replaceInCloudinary = async (oldPublicId, newFilePath, folder = 'material-transfer') => {
  try {
    // Delete old image if it exists
    if (oldPublicId) {
      await deleteFromCloudinary(oldPublicId);
    }
    
    // Upload new image
    return await uploadToCloudinary(newFilePath, folder);
  } catch (error) {
    throw new Error(`Image replacement failed: ${error.message}`);
  }
};

export default {
  upload,
  uploadToCloudinary,
  uploadMultipleToCloudinary,
  deleteFromCloudinary,
  deleteMultipleFromCloudinary,
  extractPublicId,
  replaceInCloudinary
};