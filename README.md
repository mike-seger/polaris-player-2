# Polaeis Player 2

This is a web audio player supporting playlists.
Currently it supports playing Youtube Ausio/Video playlists.

For full functionality, it requires the provided server application and an API key
for its full functionality.

It does support running serverless, but currently only with a static YT
playlist.  

## build instructions for mac OS
```
brew install node
npm install

cp .env.example .env

# in .env
YT_API_KEY=YOUR_API_KEY_HERE
PORT=33001

npm start

# Or use auto-reload during development
npm run dev

```

## start a plain file server
```
python3 -m http.server 8000 --directory public
```


