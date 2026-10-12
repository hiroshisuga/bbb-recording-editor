/**
 * Creates an image asset object for use in a Tldraw v2 presentation. This function initializes an image asset with
 * specified dimensions and a source URL. The asset is identified by a unique assetId and is configured with default
 * properties for a Tldraw image asset.
 *
 * @param {string|TLAssetId} assetId - The unique AssetRecordType identifier for the new image asset.
 * @param {string} imageUrl - The URL of the image to be used as the source for the asset.
 * @param {number} scaledWidth - The width of the image asset after scaling.
 * @param {number} scaledHeight - The height of the image asset after scaling.
 * @returns {Object} An object representing the image asset.
 */
const createTldrawImageAsset = (assetId, imageUrl, scaledWidth, scaledHeight) => {
  return {
    id: assetId,
    typeName: "asset",
    type: "image",
    meta: {},
    props: {
      w: scaledWidth,
      h: scaledHeight,
      src: imageUrl,
      name: "",
      isAnimated: false,
      mimeType: null,
    }
  };
}

/**
 * Creates a background shape object for a Tldraw presentation page. The function generates a shape object
 * with predefined properties suitable for a background image. It takes the asset ID of the image, the current page ID,
 * and scaled dimensions to create the shape.
 *
 * @param {string|TLAssetId} assetId - The unique identifier for the new image asset.
 * @param {string} curPageId - The unique identifier of the current page where this background shape will be added.
 * @param {number} scaledWidth - The width of the background shape after scaling. Defaults to 1 if not provided.
 * @param {number} scaledHeight - The height of the background shape after scaling. Defaults to 1 if not provided.
 * @returns {Object} An object representing the background shape.
 */

const createTldrawBackgroundShape = (assetId, curPageId, scaledWidth, scaledHeight) => {
  return {
    x: 1,
    y: 1,
    rotation: 0,
    isLocked: true,
    opacity: 1,
    meta: {},
    id: `shape:BG-${curPageId}`,
    type: "image",
    props: {
      w: scaledWidth || 1,
      h: scaledHeight || 1,
      assetId: assetId,
      playing: true,
      url: "",
      crop: null,
    },
    parentId: `page:${curPageId}`,
    index: 'a0',
    typeName: 'shape'
  };
}

export { createTldrawImageAsset, createTldrawBackgroundShape };
