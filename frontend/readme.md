# GridFinium Frontend Guide

Welcome! This guide explains how the GridFinium frontend fits together using easy language and simple flowcharts. If you are around 14 years old and curious about how the project works, you are in the right place.

## How the codebase is organized
The project lives in a small folder with a handful of important files. Follow the flowchart to see how everything connects.

```mermaid
flowchart TD
    A[Project Folder] --> B["<u>index.html</u><br/>Shapes the web page"]
    A --> C["<u>scripts.js</u><br/>Adds interactive logic"]
    A --> D["<u>readme.md</u><br/>Explains everything"]
    A --> E["<u>docs.md</u><br/>Documentation plan"]

```

### What each part does
- **index.html** sets up the basic layout of the page, similar to building the frame of a house.
- **scripts.js** adds the behaviors, like placing the furniture and making buttons respond when clicked.
- **docs.md** stores instructions about how to document the project.
- **readme.md** (this file) shows you how the pieces fit together.

## How the main files work together
The next flowchart zooms in on the logic inside the HTML and JavaScript files and shows the usual path of information.

```mermaid
flowchart LR
    H["index.html<br/>Loads page structure"] -->|Loads| S["scripts.js<br/>Listens for user actions"]
    S -->|Reads| G["HTML elements<br/>(like buttons and grid cells)"]
    S -->|Updates| V["Visual changes<br/>shown in the browser"]
```

### Step-by-step explanation
1. **The browser reads `index.html`** and draws the page.
2. **`scripts.js` runs right after** and looks for buttons, inputs, or grid cells to control.
3. **When you interact with the page**, the script reacts by changing numbers, colors, or text.
4. **The browser updates the view**, so you instantly see the result of what just happened.

## scripts.js logic explained
The JavaScript file is made of small functions that work together whenever you upload a picture of a sheet of paper.

```mermaid
flowchart TD
    User["You pick a file<br/>from your computer"] --> Handle["handleFileSelection<br/>Checks the upload"]
    Handle -->|Creates canvas| CanvasFn["createPreviewCanvas<br/>Builds a drawing space"]
    Handle -->|Loads image| LoadImg["loadImage<br/>Waits for picture data"]
    Handle -->|Fits size| SizeFn["sizeCanvasToImage<br/>Makes canvas match photo"]
    Handle -->|Waits| WaitFn["waitForOpenCv<br/>Makes sure OpenCV is ready"]
    Handle -->|Reads pixels| Read["cv.imread<br/>Copies the picture"]
    Read --> Detect["detectPaperContour<br/>Finds the paper edges"]
    Detect -->|Paper found| Draw["cv.drawContours<br/>Draws a bright outline"]
    Draw --> Show["cv.imshow<br/>Shows the result on screen"]
    Detect -->|No paper| Show
```

### Function-by-function tour
- **`handleFileSelection(event)`** – runs when you choose a file, creates the canvas, loads the image, waits for OpenCV, and triggers the paper detection steps.
- **`createPreviewCanvas()`** – builds a fresh `<canvas>` element where the processed picture will be displayed.
- **`sizeCanvasToImage(canvas, imageElement)`** – copies the photo’s width and height onto the canvas so the outline lines up perfectly.
- **`loadImage(imageElement, src)`** – returns a promise that resolves once the browser finishes loading the image data from the chosen file.
- **`waitForOpenCv()`** – keeps checking until the OpenCV library is ready to use.
- **`detectPaperContour(src)`** – converts the picture to gray, finds strong edges, and keeps the largest four-sided shape it sees (the sheet of paper).
- **`cv.drawContours(...)` inside the handler** – if a contour is found, draws a thick green outline around it before showing the final picture.

## Paper outlining process
The outline you see on the preview is created through a few clear stages. Follow the chart and steps to understand what happens after you upload a photo.

```mermaid
flowchart TD
    A["Upload image"] --> B["Convert to grayscale"]
    B --> C["Blur to soften noise"]
    C --> D["Detect edges with Canny"]
    D --> E["Find contours"]
    E --> F{Is there a four-sided shape?}
    F -- Yes --> G["Pick the biggest one"]
    G --> H["Draw bright outline on canvas"]
    F -- No --> I["Show original image without outline"]
```

### Step-by-step
1. **Convert to grayscale.** Removing color makes it easier to spot the paper’s edges.
2. **Blur the picture.** A gentle blur washes away tiny speckles so the outline is less wiggly.
3. **Find edges.** The Canny algorithm traces strong transitions from dark to light, highlighting the paper border.
4. **Search for contours.** The script gathers shapes formed by those edges.
5. **Pick the paper.** It looks for the largest contour with four sides—this is almost always the sheet.
6. **Draw the outline.** A bright green contour is painted onto the canvas so you can clearly see the detected paper.
7. **Fallback if nothing fits.** If no four-sided shape is found, the original photo is shown so you know detection failed.

## Why the preview images are scaled down
Modern phones can take photos that are thousands of pixels tall and wide. Showing that entire image inside the browser would
force the canvas to hold all of those pixels even if the picture looks small on screen. On some devices—especially iPhones
running Safari—pinching to zoom tells the browser to render the full-resolution canvas, which can quickly use too much memory
and crash the page. To keep things smooth, `scripts.js` now shrinks anything bigger than about 1,280 pixels on its longest side
before drawing it. The paper detection still uses the original high-resolution pixels, but the preview stays lightweight and
stable when you zoom in.

## Need to change something?
- Update `index.html` if you want to change the layout or add new sections to the page.
- Edit `scripts.js` if you want to change how the page behaves when someone clicks or types.
- Keep this `readme.md` updated so future developers (and curious students) can follow along easily.

Happy exploring and building!

## Hint-based selection walkthrough
When you tap or click on the preview we run an extra mini-pipeline that finds the
shape surrounding your hint. Follow the diagram to see the steps.

```mermaid
flowchart TD
    A["You click a hint point"] --> B["Convert image to gray again"]
    B --> C["Blur slightly to quiet noise"]
    C --> D["Detect edges with tuned thresholds"]
    D --> E["Clean edges with a small kernel"]
    E --> F["Collect all contours"]
    F --> G["Pick the smallest contour that contains the hint"]
    G --> H["Show pink selection overlay"]
```

### Settings you can tweak
Several numbers control which contour wins once a hint is supplied:

- **Canny thresholds (40, 120)** decide how strong an edge must be before it is
  kept. Lower values make the picker more sensitive, which helps highlight
  smaller objects like the coaster at the cost of catching more noise.
- **Morphology kernel size (5×5)** closes gaps between edge pixels. Increase it
  to merge nearby edges into one shape, or shrink it to keep neighboring objects
  separate so the coaster does not blend into the surrounding paper.
- **Minimum contour area (`imageArea × 0.0001`)** filters out tiny fragments.
  Reduce this ratio if the coaster is still ignored, or raise it to focus only
  on large objects such as the sheet of paper.

Adjusting these values in `findContourAtPoint` inside `scripts.js` lets you
fine-tune what is selected after a hint. Try lowering the thresholds first, and
then tweak the kernel size or minimum area until the pink overlay hugs the
coaster instead of the entire page.

You can now experiment with these numbers directly from the **Tuning Parameters**
panel on the Image Tools tab—no code edits required. Adjust the sliders, click
the preview again, and watch the hint selection update instantly.
