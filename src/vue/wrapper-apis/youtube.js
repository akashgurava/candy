import ipcClient from '../ipc/client';

function fetchText(url) {
    return fetch(url).then(res => {
        if (res.ok) {
            return res.text();
        } else {
            throw res;
        }
    });
}

/**
 * All youtube pages come with some pre-defined content saved in a object named
 * ytInitialData. This function extracts this object from a yt page and returns it
 * as normal javascript object.
 * @param html
 * @returns {*}
 */
function extractYTInitialData(html) {

    // Extract script elements
    const tmp = document.createElement('div');
    tmp.innerHTML = html;

    // Find script tag with ytInitialData
    const scripts = Array.from(tmp.querySelectorAll('script'));
    const targetScriptString = scripts.map(v => v.innerHTML)
        .find(v => v.trim().match(/^window\["ytInitialData"]/));

    if (targetScriptString) {
        const returnObjectString = targetScriptString.replace(/^[ \t\r\n]+window\["ytInitialData"] *= */, '');
        return new Function(`return ${returnObjectString}`)();
    }

    return null;
}

/**
 * Resolves the latest 30 videos from a channel
 * @param channelid
 * @returns {Promise<[any, any, any, any, any, any, any, any, any, any] | never>}
 */
export async function getLatestVideosByChannel(channelid) {
    return fetchText(`https://www.youtube.com/channel/${channelid}/videos`)
        .catch(() => fetchText(`https://www.youtube.com/user/${channelid}/videos`))
        .then(async html => {
            const ytInitialData = extractYTInitialData(html);
            const {microformatDataRenderer} = ytInitialData.microformat;
            const {items} = ytInitialData.contents.twoColumnBrowseResultsRenderer.tabs[1].tabRenderer.content.sectionListRenderer.contents[0].itemSectionRenderer.contents[0].gridRenderer;
            const videos = [];

            for (const {gridVideoRenderer: rv} of items) {
                videos.push(ipcClient.request('getVideoInfo', rv.videoId));
            }

            return {
                info: microformatDataRenderer,
                videos: await Promise.all(videos)
            };
        });
}

/**
 * Resolves all playlistitems
 * @param playlistId
 * @returns {Promise<void>}
 */
export async function getPlaylistVideos(playlistId) {
    const triedIds = [];

    // Fetch first raw page
    return fetchText(`https://www.youtube.com/playlist?list=${playlistId}`).then(async html => {
        const ytInitialData = extractYTInitialData(html);
        const {microformatDataRenderer} = ytInitialData.microformat;
        const playlistItems = ytInitialData.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[0].itemSectionRenderer.contents[0].playlistVideoListRenderer.contents;

        // Resolve first <100 videos
        return {
            info: microformatDataRenderer,
            videos: await Promise.all(playlistItems.map(
                v => {
                    const {videoId} = v.playlistVideoRenderer;
                    triedIds.push(videoId);
                    return ipcClient.request('getVideoInfo', videoId)
                        .catch(() => null);
                }
            ))
        };
    }).then(async ({info, videos}) => {

        // Youtube renders at least 99 items on the first page. If so it's not required to fetch the next pages
        if (videos.length < 99 && !videos.length) {
            return videos;
        }

        videos = videos.filter(Boolean); // Remove dead links

        let nextLink = videos[videos.length - 1].video_id;
        while (nextLink) {

            // Fetch playlist-video pages html content
            const nextPage = await fetchText(`https://www.youtube.com/watch?v=${nextLink}&list=${playlistId}`);

            if (!nextPage) {
                throw 'Failed to fetch ids';
            }

            // Extract playlist ids
            const ytInitialData = extractYTInitialData(nextPage);
            const {contents} = ytInitialData.contents.twoColumnWatchNextResults.playlist.playlist;

            // Resolve ids and add these to the current list
            const promises = [];
            for (const {playlistPanelVideoRenderer: {videoId}} of contents) {
                if (!triedIds.find(v => v === videoId)) {
                    triedIds.push(videoId);
                    promises.push(
                        ipcClient.request('getVideoInfo', videoId).catch(() => null)
                    );
                }
            }

            // Check if something new has been added
            if (promises.length) {
                videos.push(...(await Promise.all(promises)));
                videos = videos.filter(Boolean); // Remove dead links
                nextLink = videos[videos.length - 1].video_id;
            } else {
                nextLink = null;
            }
        }

        return {videos, info};
    });
}
