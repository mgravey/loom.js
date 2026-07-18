#target aftereffects

/*
 * Exact-ribbon Loom.js mark animation builder.
 *
 * This updates only the smooth alternative; loom-logo-lottie.jsx is untouched.
 * Each color uses the accepted closed ribbon silhouette from loom-mark-08.svg.
 * A centerline Trim Path reveals that fixed shape from left to right, without
 * scaling or changing the final geometry. There is no text or background layer.
 */

(function buildExactRibbonLoomMark() {
  var WIDTH = 1254;
  var HEIGHT = 1254;
  var DURATION = 3.2;
  var FRAME_RATE = 60;
  var MATTE_WIDTH = 176;
  var RING_SIZE = 126;
  var RING_WIDTH = 42;

  var INDIGO = [79 / 255, 70 / 255, 229 / 255];
  var CYAN = [6 / 255, 182 / 255, 212 / 255];
  var CORAL = [251 / 255, 113 / 255, 133 / 255];
  var SILENT = $.global.__LOOM_SILENT__ === true;

  function prop(item, matchName) {
    return item.property(matchName);
  }

  function setBezierInterpolation(property) {
    var i;
    for (i = 1; i <= property.numKeys; i += 1) {
      property.setInterpolationTypeAtKey(
        i,
        KeyframeInterpolationType.BEZIER,
        KeyframeInterpolationType.BEZIER
      );
    }
  }

  function uniqueItemName(baseName) {
    var candidate = baseName;
    var version = 2;
    var exists;
    var i;

    while (true) {
      exists = false;
      for (i = 1; i <= app.project.numItems; i += 1) {
        if (app.project.item(i).name === candidate) {
          exists = true;
          break;
        }
      }
      if (!exists) {
        return candidate;
      }
      candidate = baseName + "_v" + version;
      version += 1;
    }
  }

  function smoothOpenShape(vertices) {
    var shape = new Shape();
    var inTangents = [];
    var outTangents = [];
    var last = vertices.length - 1;
    var previous;
    var next;
    var i;

    for (i = 0; i <= last; i += 1) {
      previous = vertices[i === 0 ? 0 : i - 1];
      next = vertices[i === last ? last : i + 1];
      inTangents.push([
        -(next[0] - previous[0]) / 6,
        -(next[1] - previous[1]) / 6
      ]);
      outTangents.push([
        (next[0] - previous[0]) / 6,
        (next[1] - previous[1]) / 6
      ]);
    }

    shape.vertices = vertices;
    shape.inTangents = inTangents;
    shape.outTangents = outTangents;
    shape.closed = false;
    return shape;
  }

  function distance(a, b) {
    return Math.sqrt(Math.pow(a[0] - b[0], 2) + Math.pow(a[1] - b[1], 2));
  }

  function isSharpCorner(vertices, index) {
    var count = vertices.length;
    var previous = vertices[(index - 1 + count) % count];
    var current = vertices[index];
    var next = vertices[(index + 1) % count];
    var incoming = [current[0] - previous[0], current[1] - previous[1]];
    var outgoing = [next[0] - current[0], next[1] - current[1]];
    var incomingLength = distance(previous, current);
    var outgoingLength = distance(current, next);
    var cosine;

    if (current[0] <= 113 || current[0] >= 999) {
      return true;
    }
    if (Math.min(incomingLength, outgoingLength) < 4) {
      return false;
    }
    cosine =
      (incoming[0] * outgoing[0] + incoming[1] * outgoing[1]) /
      (incomingLength * outgoingLength);
    return cosine < 0.55;
  }

  function tracedClosedShape(vertices) {
    var shape = new Shape();
    var inTangents = [];
    var outTangents = [];
    var count = vertices.length;
    var nextIndex;
    var previous;
    var current;
    var next;
    var after;
    var i;

    for (i = 0; i < count; i += 1) {
      inTangents.push([0, 0]);
      outTangents.push([0, 0]);
    }
    for (i = 0; i < count; i += 1) {
      nextIndex = (i + 1) % count;
      previous = vertices[(i - 1 + count) % count];
      current = vertices[i];
      next = vertices[nextIndex];
      after = vertices[(i + 2) % count];
      if (!isSharpCorner(vertices, i)) {
        outTangents[i] = [
          (next[0] - previous[0]) / 6,
          (next[1] - previous[1]) / 6
        ];
      }
      if (!isSharpCorner(vertices, nextIndex)) {
        inTangents[nextIndex] = [
          -(after[0] - current[0]) / 6,
          -(after[1] - current[1]) / 6
        ];
      }
    }
    shape.vertices = vertices;
    shape.inTangents = inTangents;
    shape.outTangents = outTangents;
    shape.closed = true;
    return shape;
  }

  function addDrawMatte(comp, name, vertices, delay) {
    var layer = comp.layers.addShape();
    var root = prop(layer, "ADBE Root Vectors Group");
    var group = root.addProperty("ADBE Vector Group");
    var contents = prop(group, "ADBE Vectors Group");
    var pathGroup;
    var stroke;
    var trim;
    var trimEnd;
    layer.name = name + " — Draw Matte";
    group.name = name + " Draw Path";

    // Configure each indexed child before adding the next one. After Effects
    // invalidates older property handles when another vector child is added.
    pathGroup = contents.addProperty("ADBE Vector Shape - Group");
    prop(pathGroup, "ADBE Vector Shape").setValue(
      smoothOpenShape(vertices)
    );

    stroke = contents.addProperty("ADBE Vector Graphic - Stroke");
    prop(stroke, "ADBE Vector Stroke Color").setValue([1, 1, 1]);
    prop(stroke, "ADBE Vector Stroke Width").setValue(MATTE_WIDTH);
    prop(stroke, "ADBE Vector Stroke Line Cap").setValue(1);
    prop(stroke, "ADBE Vector Stroke Line Join").setValue(2);

    trim = contents.addProperty("ADBE Vector Filter - Trim");
    trimEnd = prop(trim, "ADBE Vector Trim End");
    trimEnd.setValueAtTime(0.14 + delay, 0);
    trimEnd.setValueAtTime(1.42 + delay, 100);
    setBezierInterpolation(trimEnd);

    prop(prop(layer, "ADBE Transform Group"), "ADBE Anchor Point").setValue([0, 0]);
    prop(prop(layer, "ADBE Transform Group"), "ADBE Position").setValue([0, 0]);
    return layer;
  }

  function addRibbon(comp, name, color, outlineVertices, drawVertices, delay) {
    var layer = comp.layers.addShape();
    var root = prop(layer, "ADBE Root Vectors Group");
    var group = root.addProperty("ADBE Vector Group");
    var contents = prop(group, "ADBE Vectors Group");
    var pathGroup;
    var fill;
    var matte;

    layer.name = name;
    group.name = name + " Exact Ribbon";

    pathGroup = contents.addProperty("ADBE Vector Shape - Group");
    prop(pathGroup, "ADBE Vector Shape").setValue(
      tracedClosedShape(outlineVertices)
    );

    fill = contents.addProperty("ADBE Vector Graphic - Fill");
    prop(fill, "ADBE Vector Fill Color").setValue(color);

    prop(prop(layer, "ADBE Transform Group"), "ADBE Anchor Point").setValue([0, 0]);
    prop(prop(layer, "ADBE Transform Group"), "ADBE Position").setValue([0, 0]);

    matte = addDrawMatte(comp, name, drawVertices, delay);
    if (layer.setTrackMatte) {
      layer.setTrackMatte(matte, TrackMatteType.ALPHA);
    } else {
      layer.trackMatteType = TrackMatteType.ALPHA;
    }
    return layer;
  }

  function addEndpoint(comp, name, color, x, y, delay) {
    var layer = comp.layers.addShape();
    var root = prop(layer, "ADBE Root Vectors Group");
    var group = root.addProperty("ADBE Vector Group");
    var contents = prop(group, "ADBE Vectors Group");
    var ellipse;
    var stroke;
    var trim;
    var trimEnd;
    var transform;

    layer.name = name;
    group.name = name + " Ring";

    ellipse = contents.addProperty("ADBE Vector Shape - Ellipse");
    prop(ellipse, "ADBE Vector Ellipse Size").setValue([RING_SIZE, RING_SIZE]);

    stroke = contents.addProperty("ADBE Vector Graphic - Stroke");
    prop(stroke, "ADBE Vector Stroke Color").setValue(color);
    prop(stroke, "ADBE Vector Stroke Width").setValue(RING_WIDTH);
    prop(stroke, "ADBE Vector Stroke Line Cap").setValue(2);

    // Draw the endpoint instead of growing or scaling it.
    trim = contents.addProperty("ADBE Vector Filter - Trim");
    trimEnd = prop(trim, "ADBE Vector Trim End");
    prop(trim, "ADBE Vector Trim Offset").setValue(-90);
    trimEnd.setValueAtTime(1.18 + delay, 0);
    trimEnd.setValueAtTime(1.64 + delay, 100);
    setBezierInterpolation(trimEnd);

    transform = prop(layer, "ADBE Transform Group");
    prop(transform, "ADBE Anchor Point").setValue([0, 0]);
    prop(transform, "ADBE Position").setValue([x, y]);
    return layer;
  }

  function buildComp(folder, baseName) {
    var comp = app.project.items.addComp(
      uniqueItemName(baseName),
      WIDTH,
      HEIGHT,
      1,
      DURATION,
      FRAME_RATE
    );

    comp.parentFolder = folder;
    comp.bgColor = [0.97, 0.98, 0.99];
    comp.workAreaStart = 0;
    comp.workAreaDuration = DURATION;
    comp.comment =
      "Exact accepted Loom.js ribbon silhouettes, revealed by Trim Paths. " +
      "No text or background layer.";

    /*
     * These closed outlines trace the accepted loom-mark-08.svg asset. The
     * layers are added coral, cyan, indigo so the crossings match the source.
     */
    addRibbon(
      comp,
      "Thread — Coral",
      CORAL,
      [[112,710],[500,710],[526,706],[549,698],[571,685],[636,621],[636,619],[638,619],[652,605],[658,602],[659,599],[662,599],[670,605],[710,623],[736,630],[768,633],[738,643],[715,658],[645,728],[645,732],[669,755],[696,773],[724,784],[751,789],[794,790],[978,790],[988,772],[1001,759],[1001,888],[997,886],[997,884],[995,884],[988,875],[747,875],[714,870],[678,858],[644,839],[642,836],[629,828],[625,823],[623,823],[619,818],[617,818],[584,785],[581,780],[577,780],[565,786],[536,795],[489,801],[112,801]],
      [[112,755],[480,755],[620,680],[740,832],[1001,832]],
      0.18
    );
    addRibbon(
      comp,
      "Thread — Cyan",
      CYAN,
      [[112,559],[497,559],[512,557],[536,551],[564,537],[576,527],[576,524],[564,514],[577,511],[604,498],[620,487],[639,469],[639,471],[641,471],[680,511],[700,526],[727,539],[755,546],[984,547],[991,535],[999,527],[1001,527],[1001,656],[991,647],[982,633],[762,633],[737,630],[711,623],[690,615],[669,604],[663,599],[660,599],[637,581],[615,602],[578,626],[542,640],[512,646],[488,648],[112,648]],
      [[112,603],[480,603],[620,540],[740,589],[1001,589]],
      0.09
    );
    addRibbon(
      comp,
      "Thread — Indigo",
      INDIGO,
      [[112,406],[492,406],[540,413],[572,424],[609,385],[632,366],[649,355],[651,356],[650,354],[655,350],[662,349],[668,343],[682,340],[681,338],[688,334],[712,326],[757,318],[984,318],[988,310],[1001,298],[1001,422],[990,412],[983,399],[759,399],[732,402],[731,405],[710,410],[693,418],[662,442],[618,488],[598,501],[567,514],[530,498],[490,492],[112,493]],
      [[112,449],[480,449],[570,480],[740,358],[1001,358]],
      0
    );

    addEndpoint(comp, "Endpoint — Indigo", INDIGO, 1057, 360, 0);
    addEndpoint(comp, "Endpoint — Cyan", CYAN, 1057, 591, 0.09);
    addEndpoint(comp, "Endpoint — Coral", CORAL, 1057, 824, 0.18);

    comp.markerProperty.setValueAtTime(0.14, new MarkerValue("Ribbons draw"));
    comp.markerProperty.setValueAtTime(1.64, new MarkerValue("Mark complete"));
    return comp;
  }

  app.beginUndoGroup("Build exact-ribbon Loom.js mark");
  try {
    if (!app.project) {
      app.newProject();
    }

    var folder = app.project.items.addFolder(
      uniqueItemName("Loom Mark — Exact Ribbons")
    );
    var comp = buildComp(folder, "Loom_Mark_Exact_Ribbons");

    comp.openInViewer();
    if (!SILENT) {
      alert(
        "Exact-ribbon Loom.js mark created.\n\n" +
          "Composition: " +
          comp.name +
          "\n\nThe final frame uses the accepted loom-mark-08 ribbon " +
          "silhouettes. There is no wordmark, text layer, or background layer."
      );
    }
  } catch (error) {
    var details = error.toString();
    if (error.line) {
      details += "\nLine: " + error.line;
    }
    if (error.fileName) {
      details += "\nFile: " + error.fileName;
    }
    if (!SILENT) {
      alert("Could not build the exact-ribbon animation:\n" + details);
    } else {
      $.writeln("Could not build the exact-ribbon animation: " + details);
    }
    throw error;
  } finally {
    app.endUndoGroup();
  }
})();
