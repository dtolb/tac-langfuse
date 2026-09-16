<style>
  :root{
    --field:#ECF1F3;
    --paper:#FFFFFF;
    --ink:#14283A;
    --muted:#5A6B7A;
    --line:#C6D2D9;
    --edge:#A8B7C0;

    /* Semantic trio. Blue is the Twilio platform, magenta is the code in this repo,
       green is observability. Callers and the model provider stay neutral grey so the
       three accents keep meaning. */
    --plat:#2E6FA3;
    --app:#C42B72;
    --obs:#2E7D5B;
    --neutral:#5A6B7A;

    --code:#0E1B27;
    --codeink:#D8E4EC;
    --codemuted:#6E879A;

    --display:"Avenir Next","Futura","Century Gothic","Trebuchet MS",sans-serif;
    --body:"Helvetica Neue",Helvetica,Arial,sans-serif;
    --mono:"SF Mono",ui-monospace,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{
    background:var(--field);color:var(--ink);
    font-family:var(--body);font-size:16px;line-height:1.55;
    background-image:
      repeating-linear-gradient(0deg, transparent 0 79px, rgba(46,111,163,.06) 79px 80px),
      repeating-linear-gradient(90deg, transparent 0 79px, rgba(46,111,163,.06) 79px 80px);
    padding:0 0 80px;
    overflow-wrap:break-word;
  }
  .wrap{max-width:1280px;margin:0 auto;padding:0 clamp(16px,4vw,24px)}

  /* hero */
  header{padding:clamp(34px,6vw,52px) 0 6px}
  .eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.22em;color:var(--plat);text-transform:uppercase}
  h1{
    font-family:var(--display);font-weight:600;
    font-size:clamp(30px,5.4vw,52px);letter-spacing:-.02em;line-height:1.06;
    margin:10px 0 14px;max-width:19ch;
  }
  .thesis{max-width:66ch;color:var(--muted);font-size:17px}
  .thesis strong{color:var(--ink);font-weight:600}
  .thesis + .thesis{margin-top:10px}
  .facts{display:flex;flex-wrap:wrap;gap:8px;margin:22px 0 0}
  .fact{
    font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;
    background:var(--paper);border:1px solid var(--line);padding:5px 10px;color:var(--muted);
  }
  .fact b{color:var(--ink);font-weight:600}

  /* section chrome */
  section{margin:48px 0 0}
  section > h2{
    font-family:var(--mono);font-size:11px;letter-spacing:.2em;text-transform:uppercase;
    color:var(--muted);padding-bottom:9px;border-bottom:1px solid var(--line);margin-bottom:22px;
    display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;
  }
  section > h2 b{color:var(--ink);font-weight:600}
  section > h2 .num{font-family:var(--mono);color:var(--plat)}
  .bulk{margin-left:auto;display:flex;gap:6px}
  .bulk button{
    font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;
    background:var(--paper);border:1px solid var(--line);color:var(--muted);
    padding:3px 8px;cursor:pointer;
  }
  .bulk button:hover{border-color:var(--ink);color:var(--ink)}
  .lede-sm{font-size:14.5px;color:var(--muted);margin:0 0 16px;max-width:78ch}
  .lede-sm b{color:var(--ink);font-weight:600}

  /* legend */
  .legend{display:flex;flex-wrap:wrap;gap:14px;margin:0 0 14px}
  .legend span{
    font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;
    color:var(--muted);display:flex;align-items:center;gap:6px;
  }
  .legend i{width:9px;height:9px;border-radius:50%;display:inline-block}

  /* topology: the panel scrolls at a min-width floor, the 9px labels never shrink */
  .topo{background:var(--paper);border:1px solid var(--line);padding:6px 10px 2px;overflow-x:auto}
  .topo svg{display:block;width:100%;min-width:980px;height:auto}
  .nlabel{font-family:var(--body);font-size:13px;fill:var(--ink)}
  .nsub{font-family:var(--mono);font-size:9px;letter-spacing:.07em;fill:var(--muted);text-transform:uppercase}
  .elabel{font-family:var(--mono);font-size:9.5px;letter-spacing:.06em;fill:var(--muted)}
  .glabel{font-family:var(--mono);font-size:9px;letter-spacing:.16em;fill:var(--muted);text-transform:uppercase}
  .node{cursor:pointer}
  .node rect{fill:var(--paper);stroke-width:1.5}
  .node:hover rect{fill:#F7FAFB}
  .node:focus{outline:none}
  .node:focus-visible rect{stroke-width:3}
  .node.sel rect{stroke-width:3;fill:#F2F7F9}
  .edge{stroke:var(--edge);stroke-width:1.4;fill:none}
  .edge.dash{stroke-dasharray:5 4}
  .gbox{stroke:var(--line);stroke-width:1;stroke-dasharray:2 6;fill:none}

  .hint{
    font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;
    color:var(--muted);margin:10px 0 0;
  }

  /* ladders */
  .lblock{margin:0 0 30px}
  .lblock > h3{
    font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;
    color:var(--ink);margin:0 0 4px;
  }
  .lblock > .sub{font-size:13.5px;color:var(--muted);margin:0 0 6px}
  .lanes{
    display:grid;grid-template-columns:repeat(5,1fr);
    position:sticky;top:0;z-index:6;
    background:var(--field);padding:12px 0 11px;border-bottom:1px solid var(--line);
  }
  .lane{display:flex;flex-direction:column;align-items:center;gap:5px;text-align:center}
  .lane .dot{width:9px;height:9px;border-radius:50%}
  .lane span{font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink)}
  .dot.plat{background:var(--plat)} .dot.app{background:var(--app)}
  .dot.obs{background:var(--obs)}   .dot.neutral{background:var(--neutral)}

  .ladder{position:relative;padding:8px 0 4px}
  .rails{position:absolute;inset:0;pointer-events:none;z-index:0}
  .rails i{position:absolute;top:0;bottom:0;width:1px;background:var(--line)}

  .spanwrap{position:relative}
  .spanmark{position:absolute;left:0;top:10px;bottom:10px;width:30px;pointer-events:none;z-index:2}
  .spanmark i{position:absolute;left:26px;top:0;bottom:0;border-left:2px dashed var(--obs)}
  .spanmark em{
    position:absolute;left:0;top:0;font-style:normal;white-space:nowrap;
    writing-mode:vertical-rl;line-height:1;
    font-family:var(--mono);font-size:9px;letter-spacing:.13em;text-transform:uppercase;
    color:var(--obs);
  }
  .ladder .detail{margin-left:40px}

  .step{position:relative;z-index:1}
  .row{
    position:relative;display:flex;align-items:center;width:100%;padding:17px 0;
    background:none;border:0;cursor:pointer;font:inherit;color:inherit;text-align:left;
  }
  .row::before{
    content:"";position:absolute;top:50%;transform:translateY(-50%);
    left:var(--from);right:calc(100% - var(--to));height:1.5px;background:var(--wc,var(--line));
  }
  .row::after,.row .head2{
    content:"";position:absolute;top:50%;transform:translateY(-50%);z-index:2;
    width:0;height:0;border-top:5px solid transparent;border-bottom:5px solid transparent;
  }
  .row[data-dir="r"]::after,.row[data-dir="b"]::after{
    left:calc(var(--to) - 8px);border-left:8px solid var(--wc,var(--line));
  }
  .row[data-dir="l"]::after,.row[data-dir="b"] .head2{
    left:var(--from);border-right:8px solid var(--wc,var(--line));
  }
  .wlabel{
    position:relative;z-index:1;background:var(--paper);border:1px solid var(--line);
    width:clamp(150px, calc(20vw - 44px), 216px);flex:0 0 auto;padding:7px 11px 9px;
    margin-left:calc((var(--from) + var(--to)) / 2);transform:translateX(-50%);
    display:flex;flex-direction:column;align-items:stretch;gap:1px;
    transition:border-color .14s,box-shadow .14s;
  }
  .wlabel .hdr{display:flex;align-items:center;justify-content:space-between}
  .wlabel .n{font-family:var(--mono);font-size:10px;letter-spacing:.12em;color:var(--muted)}
  .wlabel .t{font-size:13.5px;line-height:1.3}
  .wlabel .chev{font-size:9px;color:var(--muted);transition:transform .16s}
  .row:hover .wlabel{border-color:var(--wc,var(--ink));box-shadow:0 1px 0 var(--wc,var(--ink))}
  .row:focus-visible .wlabel{outline:2px solid var(--wc,var(--ink));outline-offset:2px}
  .step.open .wlabel{border-color:var(--wc,var(--ink));box-shadow:inset 0 0 0 1px var(--wc,var(--ink))}
  .step.open .wlabel .chev{transform:rotate(90deg)}
  .step.open .row{--wc:var(--acc)}

  /* Stacked ladder. Neither the rails nor the hop labels reflow, so below the floor the
     lane colour moves to a left border and every hop becomes a full-width panel. */
  @media (max-width:820px){
    .lanes,.rails{display:none}
    .row{padding:8px 0}
    .row::before,.row::after,.row .head2{display:none}
    .wlabel{width:100%;margin-left:0;transform:none;border-left:3px solid var(--acc,var(--line))}
    .ladder .detail{margin-left:0}
    .spanmark{display:none}
  }

  /* detail panels */
  .detail{
    background:var(--paper);border:1px solid var(--line);border-left:3px solid var(--acc,var(--line));
    padding:18px 20px 20px;margin:0 0 12px;
  }
  .detail .what{font-size:15px;margin-bottom:9px}
  .detail .why{font-size:14px;color:var(--muted)}
  .detail .why b{color:var(--ink);font-weight:600}
  .detail .why + .why{margin-top:7px}
  .node-detail dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;font-size:14px}
  .node-detail dt{
    font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;
    color:var(--muted);padding-top:3px;
  }
  .node-detail dd{color:var(--ink)}
  @media (max-width:600px){
    .node-detail dl{grid-template-columns:1fr;gap:2px}
    .node-detail dd{margin-bottom:8px}
  }

  /* cards */
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(255px,1fr));gap:14px}
  .card{
    background:var(--paper);border:1px solid var(--line);border-top:3px solid var(--acc);
    padding:16px 17px 18px;display:flex;flex-direction:column;
  }
  .card h4{font-family:var(--display);font-size:16px;font-weight:600;margin-bottom:3px}
  .card .api{font-family:var(--mono);font-size:10px;letter-spacing:.06em;color:var(--muted);margin-bottom:11px;display:block}
  .card ul{list-style:disc;padding-left:18px;font-size:13.5px;color:var(--ink);margin-bottom:14px}
  .card li{margin-bottom:6px;line-height:1.45}
  .card li:last-child{margin-bottom:0}
  .card li strong{font-weight:600}
  .card .when{
    font-family:var(--mono);font-size:9.5px;letter-spacing:.11em;text-transform:uppercase;
    color:var(--ink);border-top:1px dashed var(--line);padding-top:9px;margin-top:auto;
  }

  /* callout */
  .callout{
    background:var(--paper);border:1px solid var(--line);
    border-left:3px solid var(--acc,var(--line));padding:15px 18px 16px;margin:18px 0 0;
  }
  .callout .dtitle{
    font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;
    color:var(--ink);margin-bottom:9px;
  }
  .callout p{font-size:14px}
  .callout p + p{margin-top:8px}
  .callout ul{list-style:disc;padding-left:19px;font-size:13.5px;color:var(--ink)}
  .callout li{margin-bottom:5px;line-height:1.5}
  .callout li:last-child{margin-bottom:0}
  .callout li strong{font-weight:600}

  pre{
    background:var(--code);color:var(--codeink);font-family:var(--mono);font-size:12px;line-height:1.65;
    padding:13px 15px;overflow-x:auto;margin:14px 0 0;border-radius:2px;
  }
  pre b{color:#8FD1A8;font-weight:400}
  pre i{color:var(--codemuted);font-style:normal}
  pre u{color:#F0B37E;text-decoration:none}

  /* tables: the wrapper scrolls, never the page */
  .tablewrap{overflow-x:auto;margin:0 0 4px}
  table{width:100%;min-width:600px;border-collapse:collapse;background:var(--paper);border:1px solid var(--line)}
  th{
    font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;
    text-align:left;color:var(--muted);padding:11px 14px;border-bottom:1px solid var(--line);font-weight:400;
  }
  td{padding:12px 14px;border-bottom:1px solid var(--line);font-size:13.5px;vertical-align:top}
  tr:last-child td{border-bottom:0}
  td:first-child{width:27%;font-weight:600}
  table.wide-first td:first-child{width:34%}
  td code,p code,li code,dd code,.detail code,.callout code,th code{
    font-family:var(--mono);font-size:12px;background:var(--field);
    border:1px solid var(--line);padding:1px 4px;border-radius:2px;
  }
  td b.warn{color:var(--app)}

  /* footer */
  footer{margin:52px 0 0;border-top:1px solid var(--line);padding-top:18px}
  footer p{font-size:13px;color:var(--muted);max-width:78ch}
  footer p + p{margin-top:7px}
  footer b{color:var(--ink);font-weight:600}

  @media (prefers-reduced-motion:reduce){*{transition:none !important}html{scroll-behavior:auto}}
</style>
</head>
<body>
<div class="wrap">
