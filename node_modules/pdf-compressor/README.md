# PDF compressor

Compress pdf and img in browser.

# Installation
```bash
npm i pdf-compressor
```

```bash
yarn add pdf-compressor
```

```bash
pnpm add pdf-compressor
```

```bash
bun add pdf-compressor
```

## Usage

```typescript
// just send to the function file and options (optional)
const compressedFile = await compressPDF(file, {
    quality: 0.98, // from 0 to 1
    scale: 1, // which times to scale from original size
});
```

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details

## Authors

This project based on [@tt-p's project](https://github.com/tt-p/compactor), so thanks for the key idea
