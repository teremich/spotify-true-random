import type { Response, Request } from "express";
const express = require("express");
// @ts-ignore
import type SpotifyWebApi from "spotify-web-api-node"
const SpotifyApi = require("spotify-web-api-node");
const ejs = require("ejs");
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

require("dotenv").config();
const app = express();
const port = process.env.STR__PORT ?? "3050";
const key = randomBytes(32);
const iv = randomBytes(16);

const client_id: string = process.env.STR__CLIENT_ID!; // Your client id
const client_secret: string = process.env.STR__CLIENT_SECRET!; // Your secret

const scopes = [
    'ugc-image-upload',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'streaming',
    'app-remote-control',
    'user-read-email',
    'user-read-private',
    'playlist-read-collaborative',
    'playlist-modify-public',
    'playlist-read-private',
    'playlist-modify-private',
    'user-library-modify',
    'user-library-read',
    'user-top-read',
    'user-read-playback-position',
    'user-read-recently-played',
    'user-follow-read',
    'user-follow-modify'
];

const spotifyApi: SpotifyWebApi = new SpotifyApi({
    clientId: client_id,
    clientSecret: client_secret,
    redirectUri: `http://localhost:${port}/callback`
});

interface playlist_t {
    uri: string;
    name: string;
    ft: boolean;
    image?: string;
    id: string;
};

interface track_t {
    name: string;
    uri: string;
}

function randomize<T>(array: T[]): T[] {
    let copy = Array.from(array);
    var j: number, x: T, i: number;
    for (i = copy.length - 1; i > 0; i--) {
        j = Math.floor(Math.random() * (i + 1));
        x = copy[i];
        copy[i] = copy[j];
        copy[j] = x;
    }
    return copy;
}

app.get('/login', (req: any, res: any) => {
    res.redirect(spotifyApi.createAuthorizeURL(scopes, randomUUID()));
});

async function getAllPlaylists(): Promise<playlist_t[]> {
    let playlists: playlist_t[] = [];
    let finished = false;
    let offset = 0;
    let limit = 50;
    while (!finished) {
        const res = (await spotifyApi.getUserPlaylists({
            offset,
            limit
        })).body;
        for (let item of res.items) {
            let imgurl: string | undefined;
            for (let image of item.images) {
                if (image.width == 640) {
                    imgurl = image.url;
                }
            }
            if (item.type != "playlist") {
                continue;
            }
            playlists.push({
                ft: false,
                uri: item.uri,
                name: item.name,
                image: imgurl,
                id: item.id
            });
        }
        if (res.next) {
            offset += limit;
        } else {
            finished = true;
        }
    }
    return playlists;
}

async function getAllTracks(playlist: string): Promise<track_t[]> {
    let res: any;
    let tracks: track_t[] = [];
    do {
        if (playlist == "ft") {
            res = await spotifyApi.getMySavedTracks({
                limit: 50,
                offset: tracks.length
            });
        } else {
            res = await spotifyApi.getPlaylistTracks(playlist, {
                limit: 50,
                offset: tracks.length
            });
        }
        for (let item of res.body.items) {
            tracks.push({
                name: item.track.name,
                uri: item.track.uri
            });
        }
    } while (tracks.length < res.body.total);
    console.log(`there were ${tracks.length} tracks in the response`);
    return tracks;
}

async function placeRandomInQueue(tracks: track_t[], playlistUri: string) {
    tracks = randomize(tracks);
    let uris: string[] = [];
    for (let track of tracks) {
        uris.push(track.uri);
    }
    let res = await spotifyApi.getMyDevices();
    let devices: any[] = [];
    for (let d of res.body.devices) {
        devices.push({
            id: d.id,
            type: d.type,
            name: d.name
        });
    }
    await spotifyApi.play({
        uris: uris.slice(0, 50),
        device_id: devices[0].id
    }).catch(e => {
        console.log("error", e);
    });
    for (let i = 50; i < uris.length && i < 400; i++) {
        await spotifyApi.addToQueue(uris[i], {
            device_id: devices[0].id
        });
    }
}

app.get('/callback', async (req: any, res: Response) => {
    const error = req.query.error;
    const code = req.query.code;

    req.jwt = {};

    if (error) {
        console.error('Callback Error:', error);
        res.send(`Callback Error: ${error}`);
        return;
    }

    await spotifyApi
        .authorizationCodeGrant(code)
        .then((data: any) => {
            const access_token = data.body['access_token'];
            const refresh_token = data.body['refresh_token'];
            let expires_in = data.body['expires_in'];

            spotifyApi.setAccessToken(access_token);
            spotifyApi.setRefreshToken(refresh_token);

            console.log('access_token:', access_token);
            console.log('refresh_token:', refresh_token);

            console.log(
                `Sucessfully retreived access token. Expires in ${expires_in}s.`
            );
            expires_in = expires_in * 1000 - 5000;
            req.jwt = {
                authorization_token: access_token,
                refresh_token,
                expires: Date.now() + expires_in,
            };
        })
        .catch((error: string) => {
            console.error('Error getting Tokens:', error);
            res.send(`Error getting Tokens: ${error}`);
        });

    let playlists: playlist_t[] = [{ ft: true, name: "featured tracks", id: "", uri: "::ft" }].concat(await getAllPlaylists());
    const c = createCipheriv("aes256", key, iv);
    const enc = c.update(JSON.stringify({
        authorization_token: req.jwt.authorization_token,
        refresh_token: req.jwt.refresh_token,
        expires: req.jwt.expires
    }), "utf-8", "hex") + c.final("hex");
    ejs.renderFile("callback.ejs", { playlists, token: enc }, {}, (error, string) => {
        res.send(string);
    });
});

async function refreshToken(rfToken) {
    spotifyApi.setRefreshToken(rfToken);
    const data = await spotifyApi.refreshAccessToken();
    const access_token = data.body['access_token'];

    console.log('The access token has been refreshed!');
    console.log('access_token:', access_token);
    spotifyApi.setAccessToken(access_token);
}

app.get("/playlist/:uri", async (req: Request, res) => {
    let playlist = req.params.uri;
    const d = createDecipheriv("aes256", key, iv);
    const decrypted = d.update(<string>req.query.token, "hex", "utf-8") + d.final("utf-8");
    const info = JSON.parse(decrypted);
    if (Date.now() + 60000 > info.expires) {
        refreshToken(info.refresh_token);
    }
    spotifyApi.setAccessToken(info.authorization_token);
    spotifyApi.setRefreshToken(info.refresh_token);
    let tracks: track_t[] = await getAllTracks(playlist.split(":")[2]);
    await placeRandomInQueue(tracks, req.params.uri);
    res.redirect("/success");
});

app.listen(port, () => {
    console.log(`listening at ${port}\nhttp://localhost:${port}/login`);
});

app.use(express.static("public"));
app.use(express.json({ limit: "1mb" }));
