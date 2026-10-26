# Infinite Green Hills — Browser Game

A browser-playable edition of Infinite Green Hills with desktop and mobile controls, solo Survival and Creative modes, and room-code multiplayer.

## Run locally

Requires Node.js 22 or newer.

```sh
npm start
```

Open `http://localhost:8080`. For a friend to join over the internet, deploy the Node.js service with WebSocket upgrade support. This service serves the game and its multiplayer rooms from the same HTTPS origin.

## Multiplayer

Choose Multiplayer, host a Survival or Creative room, and share the displayed room code. Your friend opens the same URL and joins with that code. Room data is kept in server memory, so rooms end when the server restarts.
