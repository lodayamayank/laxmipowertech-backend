import Branch from '../models/Branch.js';

/**
 * Branch Authorization Middleware
 * 
 * Validates that the user has access to the branches/sites involved in the request.
 * This middleware should be used AFTER the protect middleware (authMiddleware.js).
 * 
 * Usage:
 *   router.get('/', protect, filterByUserBranches, async (req, res) => { ... });
 * 
 * How it works:
 * - Admin users (no assignedBranches or empty array): Pass through without filtering
 * - Client users (with assignedBranches): Adds branch filter to req.branchFilter for use in queries
 * 
 * IMPORTANT: This does NOT block the request, it only adds filtering context.
 * The actual filtering must be applied in the route handler using req.branchFilter.
 */

/**
 * Middleware to add branch filtering context to the request
 * Does not block requests - only adds filtering information
 */
export const filterByUserBranches = async (req, res, next) => {
  try {
    // Ensure user is authenticated
    if (!req.user) {
      return res.status(401).json({ 
        success: false,
        message: 'Authentication required' 
      });
    }

    // Get user's assigned branches
    const assignedBranches = req.user.assignedBranches || [];
    
    // If user has no assigned branches (admin), allow access to all data
    if (!assignedBranches || assignedBranches.length === 0) {
      console.log(`🔓 Branch Auth: Admin user "${req.user.name}" - No branch restrictions`);
      req.branchFilter = null; // No filtering needed
      req.isAdmin = true;
      return next();
    }

    // Populate branch details to get names
    const branches = await Branch.find({ 
      _id: { $in: assignedBranches } 
    }).select('name');

    const branchIds = branches.map(b => b._id.toString());
    const branchNames = branches.map(b => b.name);

    // Add branch filter context to request
    req.branchFilter = {
      ids: branchIds,
      names: branchNames,
      objectIds: assignedBranches // Original ObjectIds for MongoDB queries
    };
    req.isAdmin = false;

    console.log(`🔒 Branch Auth: User "${req.user.name}" restricted to branches:`, branchNames);
    
    next();
  } catch (error) {
    console.error('❌ Branch Auth Error:', error);
    // Don't block the request on error, just log it
    req.branchFilter = null;
    next();
  }
};

/**
 * Helper function to apply branch filtering to a query
 * Use this in your route handlers to filter data by user's branches
 * 
 * @param {Object} req - Express request object (must have branchFilter from middleware)
 * @param {Object} query - MongoDB query object to modify
 * @param {String} fromField - Field name for "from" site (e.g., 'from', 'fromSite')
 * @param {String} toField - Field name for "to" site (e.g., 'to', 'toSite')
 * @returns {Object} Modified query with branch filtering applied
 * 
 * Example usage:
 *   let query = {};
 *   query = applyBranchFilter(req, query, 'from', 'to');
 *   const deliveries = await UpcomingDelivery.find(query);
 */
export const applyBranchFilter = (req, query = {}, fromField = 'from', toField = 'to') => {
  // If no branch filter (admin user), return query unchanged
  if (!req.branchFilter) {
    return query;
  }

  const { names } = req.branchFilter;

  // Add OR condition: show records where either 'from' OR 'to' matches user's branches
  query.$or = [
    { [fromField]: { $in: names } },
    { [toField]: { $in: names } }
  ];

  console.log(`🔍 Applied branch filter: ${fromField} OR ${toField} in [${names.join(', ')}]`);
  
  return query;
};

/**
 * Helper function to apply branch filtering for single-site queries
 * Use this when the data only has one site field (e.g., deliverySite in Intent)
 * 
 * @param {Object} req - Express request object
 * @param {Object} query - MongoDB query object to modify
 * @param {String} siteField - Field name for the site (e.g., 'deliverySite')
 * @returns {Object} Modified query with branch filtering applied
 */
export const applySingleSiteBranchFilter = (req, query = {}, siteField = 'deliverySite') => {
  // If no branch filter (admin user), return query unchanged
  if (!req.branchFilter) {
    return query;
  }

  const { names } = req.branchFilter;

  // Add condition: show records where site matches user's branches
  query[siteField] = { $in: names };

  console.log(`🔍 Applied single-site branch filter: ${siteField} in [${names.join(', ')}]`);
  
  return query;
};

/**
 * Middleware to validate branch access for specific operations
 * Use this when you need to strictly enforce branch access (e.g., for updates/deletes)
 * 
 * @param {String} fromField - Field name for "from" site
 * @param {String} toField - Field name for "to" site
 */
export const requireBranchAccess = (fromField = 'from', toField = 'to') => {
  return async (req, res, next) => {
    try {
      // Admin users always have access
      if (!req.branchFilter) {
        return next();
      }

      const { names } = req.branchFilter;
      const fromSite = req.body[fromField];
      const toSite = req.body[toField];

      // Check if user has access to at least one of the sites
      const hasAccess = names.includes(fromSite) || names.includes(toSite);

      if (!hasAccess) {
        console.log(`❌ Branch Access Denied: User "${req.user.name}" tried to access ${fromSite} -> ${toSite}`);
        return res.status(403).json({
          success: false,
          message: 'Access denied: You do not have permission to access this site'
        });
      }

      console.log(`✅ Branch Access Granted: User "${req.user.name}" can access ${fromSite} -> ${toSite}`);
      next();
    } catch (error) {
      console.error('❌ Branch Access Check Error:', error);
      return res.status(500).json({
        success: false,
        message: 'Error validating branch access'
      });
    }
  };
};

export default filterByUserBranches;
