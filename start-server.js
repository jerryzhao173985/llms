#!/usr/bin/env node

import Server from './dist/esm/server.mjs';

async function startServer() {
  try {
    console.log('Starting server...');
    const server = new Server();
    await server.start();
    console.log('Server started successfully');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();