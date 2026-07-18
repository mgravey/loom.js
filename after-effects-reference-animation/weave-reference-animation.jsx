#target aftereffects

/*
 * Standalone Loom.js reference-weave animation builder.
 * Run with File > Scripts > Run Script File... in Adobe After Effects.
 * All artwork is generated as editable shape layers; no external asset is imported.
 */

(function buildReferenceWeaveAnimation() {
  var CONFIG = {
    width: 1254,
    height: 1254,
    frameRate: 60,
    duration: 4,
    threadWidth: 88,
    ringPathDiameter: 126,
    ringStrokeWidth: 42,
    purple: [0.35, 0.23, 1],
    cyan: [0.01, 0.71, 0.94],
    red: [1, 0.25, 0.38],
    shadowColor: [0, 0, 0],
    shadowNearOpacity: 14,
    shadowFarOpacity: 7,
    shadowNearOffset: [0, 4],
    shadowFarOffset: [0, 9]
  };

  var project;
  var comp;

  function unusedName(baseName) {
    var candidate = baseName;
    var suffix = 2;
    var found;
    var i;

    do {
      found = false;
      for (i = 1; i <= project.numItems; i += 1) {
        if (project.item(i).name === candidate) {
          candidate = baseName + " " + suffix;
          suffix += 1;
          found = true;
          break;
        }
      }
    } while (found);

    return candidate;
  }

  function shapeFromDefinition(definition) {
    var shape = new Shape();
    shape.vertices = definition.vertices;
    shape.inTangents = definition.inTangents;
    shape.outTangents = definition.outTangents;
    shape.closed = false;
    return shape;
  }

  function easeTwoKeys(property) {
    var ease = new KeyframeEase(0, 72);

    try {
      property.setInterpolationTypeAtKey(
        1,
        KeyframeInterpolationType.BEZIER,
        KeyframeInterpolationType.BEZIER
      );
      property.setInterpolationTypeAtKey(
        2,
        KeyframeInterpolationType.BEZIER,
        KeyframeInterpolationType.BEZIER
      );
      property.setTemporalEaseAtKey(1, [ease], [ease]);
      property.setTemporalEaseAtKey(2, [ease], [ease]);
    } catch (ignoreOlderAfterEffects) {
      // Default interpolation remains usable in older After Effects releases.
    }
  }

  function animateTrim(trim, startTime, endTime, offset) {
    var trimEnd = trim.property("ADBE Vector Trim End");
    trim.property("ADBE Vector Trim Start").setValue(0);
    trim.property("ADBE Vector Trim Offset").setValue(offset || 0);
    trimEnd.setValueAtTime(startTime, 0);
    trimEnd.setValueAtTime(endTime, 100);
    easeTwoKeys(trimEnd);
  }

  function placeAtCompOrigin(layer) {
    var transform = layer.property("ADBE Transform Group");
    transform.property("ADBE Anchor Point").setValue([0, 0]);
    transform.property("ADBE Position").setValue([0, 0]);
  }

  function addPathVisual(root, name, definition, color, width, opacity, offset) {
    var group = root.addProperty("ADBE Vector Group");
    var contents;
    var path;
    var stroke;
    var trim;

    group.name = name;
    contents = group.property("ADBE Vectors Group");
    path = contents.addProperty("ADBE Vector Shape - Group");
    path.name = "Bezier centerline";
    path.property("ADBE Vector Shape").setValue(shapeFromDefinition(definition));

    stroke = contents.addProperty("ADBE Vector Graphic - Stroke");
    stroke.name = "Constant width stroke";
    stroke.property("ADBE Vector Stroke Color").setValue(color);
    stroke.property("ADBE Vector Stroke Width").setValue(width);
    stroke.property("ADBE Vector Stroke Opacity").setValue(opacity);
    stroke.property("ADBE Vector Stroke Line Cap").setValue(1);
    stroke.property("ADBE Vector Stroke Line Join").setValue(2);

    trim = contents.addProperty("ADBE Vector Filter - Trim");
    trim.name = "Draw left to right";
    animateTrim(trim, definition.start, definition.end, 0);
    group
      .property("ADBE Vector Transform Group")
      .property("ADBE Vector Position")
      .setValue(offset);
  }

  function addSegment(definition) {
    var layer = comp.layers.addShape();
    var root;

    layer.name = definition.name;
    layer.label = definition.label;
    layer.comment =
      "Independent constant-width Bezier segment with synchronized vector shadows.";
    placeAtCompOrigin(layer);
    root = layer.property("ADBE Root Vectors Group");

    addPathVisual(
      root,
      "Shadow far",
      definition,
      CONFIG.shadowColor,
      CONFIG.threadWidth + 4,
      CONFIG.shadowFarOpacity,
      CONFIG.shadowFarOffset
    );
    addPathVisual(
      root,
      "Shadow near",
      definition,
      CONFIG.shadowColor,
      CONFIG.threadWidth + 1,
      CONFIG.shadowNearOpacity,
      CONFIG.shadowNearOffset
    );
    addPathVisual(root, "Thread", definition, definition.color, CONFIG.threadWidth, 100, [0, 0]);
    layer.inPoint = 0;
    layer.outPoint = CONFIG.duration;
  }

  function addEllipseVisual(root, name, center, color, width, opacity, offset, start, end) {
    var group = root.addProperty("ADBE Vector Group");
    var contents = group.property("ADBE Vectors Group");
    var ellipse;
    var stroke;
    var trim;

    group.name = name;
    ellipse = contents.addProperty("ADBE Vector Shape - Ellipse");
    ellipse.name = "Endpoint circle";
    ellipse
      .property("ADBE Vector Ellipse Size")
      .setValue([CONFIG.ringPathDiameter, CONFIG.ringPathDiameter]);
    ellipse
      .property("ADBE Vector Ellipse Position")
      .setValue([center[0] + offset[0], center[1] + offset[1]]);

    stroke = contents.addProperty("ADBE Vector Graphic - Stroke");
    stroke.name = "Ring stroke";
    stroke.property("ADBE Vector Stroke Color").setValue(color);
    stroke.property("ADBE Vector Stroke Width").setValue(width);
    stroke.property("ADBE Vector Stroke Opacity").setValue(opacity);
    stroke.property("ADBE Vector Stroke Line Cap").setValue(2);

    trim = contents.addProperty("ADBE Vector Filter - Trim");
    trim.name = "Draw ring after arrival";
    animateTrim(trim, start, end, -90);
  }

  function addRing(name, center, color, start, end, label) {
    var layer = comp.layers.addShape();
    var root;

    layer.name = name;
    layer.label = label;
    layer.comment = "The endpoint ring draws after its incoming line arrives.";
    placeAtCompOrigin(layer);
    root = layer.property("ADBE Root Vectors Group");

    addEllipseVisual(
      root,
      "Shadow far",
      center,
      CONFIG.shadowColor,
      CONFIG.ringStrokeWidth + 4,
      CONFIG.shadowFarOpacity,
      CONFIG.shadowFarOffset,
      start,
      end
    );
    addEllipseVisual(
      root,
      "Shadow near",
      center,
      CONFIG.shadowColor,
      CONFIG.ringStrokeWidth + 1,
      CONFIG.shadowNearOpacity,
      CONFIG.shadowNearOffset,
      start,
      end
    );
    addEllipseVisual(
      root,
      "Ring",
      center,
      color,
      CONFIG.ringStrokeWidth,
      100,
      [0, 0],
      start,
      end
    );
    layer.inPoint = 0;
    layer.outPoint = CONFIG.duration;
  }

  function buildSegments() {
    var segments = [
      {
        name: "01 RED - input",
        label: 1,
        color: CONFIG.red,
        start: 0.45,
        end: 1.12,
        vertices: [[111, 755], [500, 755]],
        inTangents: [[0, 0], [0, 0]],
        outTangents: [[0, 0], [0, 0]]
      },
      {
        name: "02 RED - lower branch and output",
        label: 1,
        color: CONFIG.red,
        start: 1.04,
        end: 2.54,
        vertices: [[500, 755], [760, 825], [992, 825]],
        inTangents: [[0, 0], [-85, 0], [0, 0]],
        outTangents: [[90, 0], [70, 0], [0, 0]]
      },
      {
        name: "03 RED - upper branch under weave",
        label: 1,
        color: CONFIG.red,
        start: 1.04,
        end: 1.76,
        vertices: [[500, 755], [682, 605]],
        inTangents: [[0, 0], [-58, 58]],
        outTangents: [[78, 0], [0, 0]]
      },
      {
        name: "04 CYAN - input",
        label: 2,
        color: CONFIG.cyan,
        start: 0.3,
        end: 0.99,
        vertices: [[111, 603], [500, 603]],
        inTangents: [[0, 0], [0, 0]],
        outTangents: [[0, 0], [0, 0]]
      },
      {
        name: "05 CYAN - rising branch to color seam",
        label: 2,
        color: CONFIG.cyan,
        start: 0.91,
        end: 1.55,
        vertices: [[500, 603], [640, 515]],
        inTangents: [[0, 0], [-45, 64]],
        outTangents: [[70, 0], [0, 0]]
      },
      {
        name: "06 PURPLE - input",
        label: 10,
        color: CONFIG.purple,
        start: 0.15,
        end: 0.85,
        vertices: [[111, 449], [500, 449]],
        inTangents: [[0, 0], [0, 0]],
        outTangents: [[0, 0], [0, 0]]
      },
      {
        name: "07 PURPLE - descending branch to color seam",
        label: 10,
        color: CONFIG.purple,
        start: 0.77,
        end: 1.4,
        vertices: [[500, 449], [640, 515]],
        inTangents: [[0, 0], [-43, -61]],
        outTangents: [[68, 0], [0, 0]]
      },
      {
        name: "08 CYAN - color change and middle output",
        label: 2,
        color: CONFIG.cyan,
        start: 1.32,
        end: 2.42,
        vertices: [[640, 515], [770, 590], [992, 590]],
        inTangents: [[0, 0], [-52, 0], [0, 0]],
        outTangents: [[44, 62], [70, 0], [0, 0]]
      },
      {
        name: "09 PURPLE - upper branch and output",
        label: 10,
        color: CONFIG.purple,
        start: 0.77,
        end: 2.36,
        vertices: [[500, 449], [760, 360], [992, 360]],
        inTangents: [[0, 0], [-88, 0], [0, 0]],
        outTangents: [[88, 0], [72, 0], [0, 0]]
      }
    ];
    var i;

    for (i = 0; i < segments.length; i += 1) {
      addSegment(segments[i]);
    }
  }

  app.beginUndoGroup("Build reference weave animation");
  try {
    if (!app.project) {
      app.newProject();
    }
    project = app.project;
    var assetFolder = project.items.addFolder(unusedName("Reference Weave Animation"));
    comp = project.items.addComp(
      unusedName("Reference_Weave_Draw"),
      CONFIG.width,
      CONFIG.height,
      1,
      CONFIG.duration,
      CONFIG.frameRate
    );
    comp.parentFolder = assetFolder;
    comp.comment = "Transparent Lottie-ready animation with no background layer.";

    buildSegments();
    addRing("10 PURPLE - endpoint ring", [1055, 360], CONFIG.purple, 2.34, 3, 10);
    addRing("11 CYAN - endpoint ring", [1055, 590], CONFIG.cyan, 2.4, 3.06, 2);
    addRing("12 RED - endpoint ring", [1055, 825], CONFIG.red, 2.52, 3.18, 1);
    comp.openInViewer();
    alert(
      "Created " +
        comp.name +
        ".\n\nThe composition has no background layer and exports transparently. " +
        "Enable the transparency grid in the Composition viewer to see the checkerboard."
    );
  } catch (error) {
    alert("Could not build the reference weave animation:\n" + error.toString());
    throw error;
  } finally {
    app.endUndoGroup();
  }
})();
