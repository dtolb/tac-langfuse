<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Injecting OpenTelemetry into Twilio Agent Connect: the extension surface, five code layers, and what stays invisible</title>
<meta name="description" content="Agent Connect ships no telemetry of its own. Where the real injection points are, why the streaming seam is a public method you call rather than a callback you are handed, five layers of instrumentation code, and the three quantities no span in this process can measure.">
