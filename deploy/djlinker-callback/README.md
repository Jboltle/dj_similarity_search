# djlinker-callback (GitHub Pages)

Live site: **https://jboltle.github.io/djlinker-callback/** (GitHub canonical host is lowercase.)

`index.html` is a copy of `public/oauth-callback.html` from the parent vdj-link-map repo (re-copy after edits to that file).

## Repo

Published from **https://github.com/Jboltle/djlinker-callback** (branch `main`, Pages source `/`).

## Updating the callback page

From the parent project root:

```bash
cp public/oauth-callback.html deploy/djlinker-callback/index.html
cd deploy/djlinker-callback
git add index.html && git commit -m "Sync oauth callback" && git push
```

## SoundCloud + `.env`

Use this exact redirect URI in the SoundCloud app and in `SOUNDCLOUD_REDIRECT_URI`:

`https://jboltle.github.io/djlinker-callback/`
