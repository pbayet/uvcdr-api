/**
 * Middleware Express global pour formater toutes les réponses JSON.
 */
export const responseFormatter = (req, res, next) => {
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    if (body && typeof body === "object" && "success" in body) {
      return originalJson(body);
    }

    const wrapped = {
      success: true,
      timestamp: new Date().toISOString(),
      statusCode: res.statusCode || 200,
      data: body,
    };

    return originalJson(wrapped);
  };

  next();
};
