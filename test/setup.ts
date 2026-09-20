/// <reference types="jest" />

// Global Jest test configuration setup
process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.REDIS_HOST = 'localhost';
process.env.REDIS_PORT = '6379';
process.env.MONGODB_URI = 'mongodb://localhost:27017/dispatch_engine_test';
process.env.WEBHOOK_SECRET = 'test_webhook_secret_key_32_characters_long_for_hmac';
process.env.ADMIN_TOKEN = 'test_admin_bearer_token';

// Extend Jest timeout for integration tests with Redis/MongoDB
jest.setTimeout(10000);
