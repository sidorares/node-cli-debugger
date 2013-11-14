var util = require('util'),
    path = require('path'),
    net = require('net'),
    vm = require('vm'),
    repl = require('repl'),
    inherits = util.inherits,
    spawn = require('child_process').spawn;

var Client = require('v8-debugger').Client;
exports.port = 5858;

var commands = [
  [
    'run (r)',
    'cont (c)',
    'next (n)',
    'step (s)',
    'out (o)',
    'backtrace (bt)',
    'setBreakpoint (sb)',
    'clearBreakpoint (cb)'
  ],
  [
    'watch',
    'unwatch',
    'watchers',
    'repl',
    'restart',
    'kill',
    'list',
    'scripts',
    'breakOnException',
    'breakpoints',
    'version'
  ]
];

var NO_FRAME = -1;

var helpMessage = 'Commands: ' + commands.map(function(group) {
  return group.join(', ');
}).join(',\n');


function SourceUnderline(sourceText, position, repl) {
  if (!sourceText) return '';

  var head = sourceText.slice(0, position),
      tail = sourceText.slice(position);

  // Colourize char if stdout supports colours
  if (repl.useColors) {
    tail = tail.replace(/(.+?)([^\w]|$)/, '\u001b[32m$1\u001b[39m$2');
  }

  // Return source line with coloured char at `position`
  return [
    head,
    tail
  ].join('');
}


function SourceInfo(body) {
  var result = body.exception ? 'exception in ' : 'break in ';

  if (body.script) {
    if (body.script.name) {
      var name = body.script.name,
          dir = path.resolve() + '/';

      // Change path to relative, if possible
      if (name.indexOf(dir) === 0) {
        name = name.slice(dir.length);
      }

      result += name;
    } else {
      result += '[unnamed]';
    }
  }
  result += ':';
  result += body.sourceLine + 1;

  if (body.exception) result += '\n' + body.exception.text;

  return result;
}

// This class is the repl-enabled debugger interface which is invoked on
// "node debug"
function Interface(stdin, stdout, args) {
  var self = this,
      child;

  this.stdin = stdin;
  this.stdout = stdout;
  this.args = args;

  // Two eval modes are available: controlEval and debugEval
  // But controlEval is used by default
  var opts = {
    prompt: 'debug> ',
    input: this.stdin,
    output: this.stdout,
    eval: this.controlEval.bind(this),
    useGlobal: false,
    ignoreUndefined: true
  };
  if (parseInt(process.env['NODE_NO_READLINE'], 10)) {
    opts.terminal = false;
  } else if (parseInt(process.env['NODE_FORCE_READLINE'], 10)) {
    opts.terminal = true;

    // Emulate Ctrl+C if we're emulating terminal
    if (!this.stdout.isTTY) {
      process.on('SIGINT', function() {
        self.repl.rli.emit('SIGINT');
      });
    }
  }
  if (parseInt(process.env['NODE_DISABLE_COLORS'], 10)) {
    opts.useColors = false;
  }
  this.repl = repl.start(opts);

  // Do not print useless warning
  repl._builtinLibs.splice(repl._builtinLibs.indexOf('repl'), 1);

  // Kill child process when main process dies
  this.repl.on('exit', function() {
    process.exit(0);
  });

  // Handle all possible exits
  process.on('exit', this.killChild.bind(this));
  process.once('SIGTERM', process.exit.bind(process, 0));
  process.once('SIGHUP', process.exit.bind(process, 0));

  var proto = Interface.prototype,
      ignored = ['pause', 'resume', 'exitRepl', 'handleBreak',
                 'requireConnection', 'killChild', 'trySpawn',
                 'controlEval', 'debugEval', 'print', 'childPrint',
                 'clearline'],
      shortcut = {
        'run': 'r',
        'cont': 'c',
        'next': 'n',
        'step': 's',
        'out': 'o',
        'backtrace': 'bt',
        'setBreakpoint': 'sb',
        'clearBreakpoint': 'cb',
        'pause_': 'pause'
      };

  function defineProperty(key, protoKey) {
    // Check arity
    var fn = proto[protoKey].bind(self);

    if (proto[protoKey].length === 0) {
      Object.defineProperty(self.repl.context, key, {
        get: fn,
        enumerable: true,
        configurable: false
      });
    } else {
      self.repl.context[key] = fn;
    }
  };

  // Copy all prototype methods in repl context
  // Setup them as getters if possible
  for (var i in proto) {
    if (Object.prototype.hasOwnProperty.call(proto, i) &&
        ignored.indexOf(i) === -1) {
      defineProperty(i, i);
      if (shortcut[i]) defineProperty(shortcut[i], i);
    }
  }

  this.killed = false;
  this.waiting = null;
  this.paused = 0;
  this.context = this.repl.context;
  this.history = {
    debug: [],
    control: []
  };
  this.breakpoints = [];
  this._watchers = [];

  // Run script automatically
  this.pause();

  // XXX Need to figure out why we need this delay
  setTimeout(function() {

    self.run(function() {
      self.resume();
    });
  }, 10);
}


// Stream control


Interface.prototype.pause = function() {
  if (this.killed || this.paused++ > 0) return false;
  this.repl.rli.pause();
  this.stdin.pause();
};

Interface.prototype.resume = function(silent) {
  if (this.killed || this.paused === 0 || --this.paused !== 0) return false;
  this.repl.rli.resume();
  if (silent !== true) {
    this.repl.displayPrompt();
  }
  this.stdin.resume();

  if (this.waiting) {
    this.waiting();
    this.waiting = null;
  }
};


// Clear current line
Interface.prototype.clearline = function() {
  if (this.stdout.isTTY) {
    this.stdout.cursorTo(0);
    this.stdout.clearLine(1);
  } else {
    this.stdout.write('\b');
  }
};

// Print text to output stream
Interface.prototype.print = function(text, oneline) {
  if (this.killed) return;
  this.clearline();

  this.stdout.write(typeof text === 'string' ? text : util.inspect(text));

  if (oneline !== true) {
    this.stdout.write('\n');
  }
};

// Format and print text from child process
Interface.prototype.childPrint = function(text) {
  this.print(text.toString().split(/\r\n|\r|\n/g).filter(function(chunk) {
    return chunk;
  }).map(function(chunk) {
    return '< ' + chunk;
  }).join('\n'));
  this.repl.displayPrompt(true);
};

// Errors formatting
Interface.prototype.error = function(text) {
  this.print(text);
  this.resume();
};


// Debugger's `break` event handler
Interface.prototype.handleBreak = function(r) {
  var self = this;

  this.pause();

  // Save execution context's data
  this.client.currentSourceLine = r.sourceLine;
  this.client.currentSourceLineText = r.sourceLineText;
  this.client.currentSourceColumn = r.sourceColumn;
  this.client.currentFrame = 0;
  this.client.currentScript = r.script && r.script.name;

  // Print break data
  this.print(SourceInfo(r));

  // Show watchers' values
  this.watchers(true, function(err) {
    if (err) return self.error(err);

    // And list source
    self.list(2);

    self.resume(true);
  });
};


// Internal method for checking connection state
Interface.prototype.requireConnection = function() {
  if (!this.client) {
    this.error('App isn\'t running... Try `run` instead');
    return false;
  }
  return true;
};


// Evals

// Used for debugger's commands evaluation and execution
Interface.prototype.controlEval = function(code, context, filename, callback) {
  try {
    // Repeat last command if empty line are going to be evaluated
    if (this.repl.rli.history && this.repl.rli.history.length > 0) {
      if (code === '(\n)') {
        code = '(' + this.repl.rli.history[0] + '\n)';
      }
    }

    var result = vm.runInContext(code, context, filename);

    // Repl should not ask for next command
    // if current one was asynchronous.
    if (this.paused === 0) return callback(null, result);

    // Add a callback for asynchronous command
    // (it will be automatically invoked by .resume() method
    this.waiting = function() {
      callback(null, result);
    };
  } catch (e) {
    callback(e);
  }
};

// Used for debugger's remote evaluation (`repl`) commands
Interface.prototype.debugEval = function(code, context, filename, callback) {
  if (!this.requireConnection()) return;

  var self = this,
      client = this.client;

  // Repl asked for scope variables
  if (code === '.scope') {
    client.reqScopes(callback);
    return;
  }

  var frame = client.currentFrame === NO_FRAME ? frame : undefined;

  self.pause();

  // Request remote evaluation globally or in current frame
  client.reqFrameEval(code, frame, function(err, res) {
    if (err) {
      callback(err);
      self.resume(true);
      return;
    }

    // Request object by handles (and it's sub-properties)
    client.mirrorObject(res, 3, function(err, mirror) {
      callback(null, mirror);
      self.resume(true);
    });
  });
};


// Utils

// Returns number of digits (+1)
function intChars(n) {
  // TODO dumb:
  if (n < 50) {
    return 3;
  } else if (n < 950) {
    return 4;
  } else if (n < 9950) {
    return 5;
  } else {
    return 6;
  }
}

// Adds spaces and prefix to number
function leftPad(n, prefix) {
  var s = n.toString(),
      nchars = intChars(n),
      nspaces = nchars - s.length - 1;

  prefix || (prefix = ' ');

  for (var i = 0; i < nspaces; i++) {
    prefix += ' ';
  }

  return prefix + s;
}


// Commands


// Print help message
Interface.prototype.help = function() {
  this.print(helpMessage);
};


// Run script
Interface.prototype.run = function() {
  var callback = arguments[0];

  if (this.child) {
    this.error('App is already running... Try `restart` instead');
    callback && callback(true);
  } else {
    this.trySpawn(callback);
  }
};


// Restart script
Interface.prototype.restart = function() {
  if (!this.requireConnection()) return;

  var self = this;

  self.pause();
  self.killChild();

  // XXX need to wait a little bit for the restart to work?
  setTimeout(function() {
    self.trySpawn();
    self.resume();
  }, 1000);
};


// Print version
Interface.prototype.version = function() {
  if (!this.requireConnection()) return;

  var self = this;

  this.pause();
  this.client.reqVersion(function(err, v) {
    if (err) {
      self.error(err);
    } else {
      self.print(v);
    }
    self.resume();
  });
};

// List source code
Interface.prototype.list = function(delta) {
  if (!this.requireConnection()) return;

  delta || (delta = 5);

  var self = this,
      client = this.client,
      from = client.currentSourceLine - delta + 1,
      to = client.currentSourceLine + delta + 1;

  self.pause();
  client.reqSource(from, to, function(err, res) {
    if (err || !res) {
      self.error('You can\'t list source code right now');
      self.resume();
      return;
    }

    var lines = res.source.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var lineno = res.fromLine + i + 1;
      if (lineno < from || lineno > to) continue;

      var current = lineno == 1 + client.currentSourceLine,
          breakpoint = client.breakpoints.some(function(bp) {
            return bp.script === client.currentScript &&
                   bp.line == lineno;
          });

      if (lineno == 1) {
        // The first line needs to have the module wrapper filtered out of
        // it.
        var wrapper = require('module').wrapper[0];
        lines[i] = lines[i].slice(wrapper.length);

        client.currentSourceColumn -= wrapper.length;
      }

      // Highlight executing statement
      var line;
      if (current) {
        line = SourceUnderline(lines[i],
                               client.currentSourceColumn,
                               self.repl);
      } else {
        line = lines[i];
      }

      self.print(leftPad(lineno, breakpoint && '*') + ' ' + line);
    }
    self.resume();
  });
};

// Print backtrace
Interface.prototype.backtrace = function() {
  if (!this.requireConnection()) return;

  var self = this,
      client = this.client;

  self.pause();
  client.fullTrace(function(err, bt) {
    if (err) {
      self.error('Can\'t request backtrace now');
      self.resume();
      return;
    }

    if (bt.totalFrames == 0) {
      self.print('(empty stack)');
    } else {
      var trace = [],
          firstFrameNative = bt.frames[0].script.isNative;

      for (var i = 0; i < bt.frames.length; i++) {
        var frame = bt.frames[i];
        if (!firstFrameNative && frame.script.isNative) break;

        var text = '#' + i + ' ';
        if (frame.func.inferredName && frame.func.inferredName.length > 0) {
          text += frame.func.inferredName + ' ';
        }
        text += path.basename(frame.script.name) + ':';
        text += (frame.line + 1) + ':' + (frame.column + 1);

        trace.push(text);
      }

      self.print(trace.join('\n'));
    }

    self.resume();
  });
};


// First argument tells if it should display internal node scripts or not
// (available only for internal debugger's functions)
Interface.prototype.scripts = function() {
  if (!this.requireConnection()) return;

  var client = this.client,
      displayNatives = arguments[0] || false,
      scripts = [];

  this.pause();
  for (var id in client.scripts) {
    var script = client.scripts[id];
    if (typeof script == 'object' && script.name) {
      if (displayNatives ||
          script.name == client.currentScript ||
          !script.isNative) {
        scripts.push(
            (script.name == client.currentScript ? '* ' : '  ') +
            id + ': ' +
            path.basename(script.name)
        );
      }
    }
  }
  this.print(scripts.join('\n'));
  this.resume();
};


// Continue execution of script
Interface.prototype.cont = function() {
  if (!this.requireConnection()) return;
  this.pause();

  var self = this;
  this.client.reqContinue(function(err) {
    if (err) self.error(err);
    self.resume();
  });
};


// Step commands generator
Interface.stepGenerator = function(type, count) {
  return function() {
    if (!this.requireConnection()) return;

    var self = this;

    self.pause();
    self.client.step(type, count, function(err, res) {
      if (err) self.error(err);
      self.resume();
    });
  };
};


// Jump to next command
Interface.prototype.next = Interface.stepGenerator('next', 1);


// Step in
Interface.prototype.step = Interface.stepGenerator('in', 1);


// Step out
Interface.prototype.out = Interface.stepGenerator('out', 1);


// Watch
Interface.prototype.watch = function(expr) {
  this._watchers.push(expr);
};

// Unwatch
Interface.prototype.unwatch = function(expr) {
  var index = this._watchers.indexOf(expr);

  // Unwatch by expression
  // or
  // Unwatch by watcher number
  this._watchers.splice(index !== -1 ? index : +expr, 1);
};

// List watchers
Interface.prototype.watchers = function() {
  var self = this,
      verbose = arguments[0] || false,
      callback = arguments[1] || function() {},
      waiting = this._watchers.length,
      values = [];

  this.pause();

  if (!waiting) {
    this.resume();

    return callback();
  }

  this._watchers.forEach(function(watcher, i) {
    self.debugEval(watcher, null, null, function(err, value) {
      values[i] = err ? '<error>' : value;
      wait();
    });
  });

  function wait() {
    if (--waiting === 0) {
      if (verbose) self.print('Watchers:');

      self._watchers.forEach(function(watcher, i) {
        self.print(leftPad(i, ' ') + ': ' + watcher + ' = ' +
                   JSON.stringify(values[i]));
      });

      if (verbose) self.print('');

      self.resume();

      callback(null);
    }
  }
};

// Break on exception
Interface.prototype.breakOnException = function breakOnException() {
  if (!this.requireConnection()) return;

  var self = this;

  // Break on exceptions
  this.pause();
  this.client.reqSetExceptionBreak('all', function(err, res) {
    self.resume();
  });
};

// Add breakpoint
Interface.prototype.setBreakpoint = function(script, line,
                                             condition, silent) {
  if (!this.requireConnection()) return;

  var self = this,
      scriptId,
      ambiguous;

  // setBreakpoint() should insert breakpoint on current line
  if (script === undefined) {
    script = this.client.currentScript;
    line = this.client.currentSourceLine + 1;
  }

  // setBreakpoint(line-number) should insert breakpoint in current script
  if (line === undefined && typeof script === 'number') {
    line = script;
    script = this.client.currentScript;
  }

  if (/\(\)$/.test(script)) {
    // setBreakpoint('functionname()');
    var req = {
      type: 'function',
      target: script.replace(/\(\)$/, ''),
      condition: condition
    };
  } else {
    // setBreakpoint('scriptname')
    if (script != +script && !this.client.scripts[script]) {
      var scripts = this.client.scripts;
      Object.keys(scripts).forEach(function(id) {
        if (scripts[id] && scripts[id].name.indexOf(script) !== -1) {
          if (scriptId) {
            ambiguous = true;
          }
          scriptId = id;
        }
      });
    } else {
      scriptId = script;
    }

    if (ambiguous) return this.error('Script name is ambiguous');
    if (line <= 0) return this.error('Line should be a positive value');

    var req;
    if (scriptId) {
      req = {
        type: 'scriptId',
        target: scriptId,
        line: line - 1,
        condition: condition
      };
    } else {
      this.print('Warning: script \'' + script + '\' was not loaded yet.');
      var escapedPath = script.replace(/([/\\.?*()^${}|[\]])/g, '\\$1');
      var scriptPathRegex = '^(.*[\\/\\\\])?' + escapedPath + '$';
      req = {
        type: 'scriptRegExp',
        target: scriptPathRegex,
        line: line - 1,
        condition: condition
      };
    }
  }

  self.pause();
  self.client.setBreakpoint(req, function(err, res) {
    if (err) {
      if (!silent) {
        self.error(err);
      }
    } else {
      if (!silent) {
        self.list(5);
      }

      // Try load scriptId and line from response
      if (!scriptId) {
        scriptId = res.script_id;
        line = res.line + 1;
      }

      // Remember this breakpoint even if scriptId is not resolved yet
      self.client.breakpoints.push({
        id: res.breakpoint,
        scriptId: scriptId,
        script: (self.client.scripts[scriptId] || {}).name,
        line: line,
        condition: condition,
        scriptReq: script
      });
    }
    self.resume();
  });
};

// Clear breakpoint
Interface.prototype.clearBreakpoint = function(script, line) {
  if (!this.requireConnection()) return;

  var ambiguous,
      breakpoint,
      index;

  this.client.breakpoints.some(function(bp, i) {
    if (bp.scriptId === script ||
        bp.scriptReq === script ||
        (bp.script && bp.script.indexOf(script) !== -1)) {
      if (index !== undefined) {
        ambiguous = true;
      }
      if (bp.line === line) {
        index = i;
        breakpoint = bp.id;
        return true;
      }
    }
  });

  if (ambiguous) return this.error('Script name is ambiguous');

  if (breakpoint === undefined) {
    return this.error('Script : ' + script + ' not found');
  }

  var self = this,
      req = {
        breakpoint: breakpoint
      };

  self.pause();
  self.client.clearBreakpoint(req, function(err, res) {
    if (err) {
      self.error(err);
    } else {
      self.client.breakpoints.splice(index, 1);
      self.list(5);
    }
    self.resume();
  });
};


// Show breakpoints
Interface.prototype.breakpoints = function() {
  if (!this.requireConnection()) return;

  this.pause();
  var self = this;
  this.client.listbreakpoints(function(err, res) {
    if (err) {
      self.error(err);
    } else {
      self.print(res);
      self.resume();
    }
  });
};


// Pause child process
Interface.prototype.pause_ = function() {
  if (!this.requireConnection()) return;

  var self = this,
      cmd = 'process._debugPause();';

  this.pause();
  this.client.reqFrameEval(cmd, NO_FRAME, function(err, res) {
    if (err) {
      self.error(err);
    } else {
      self.resume();
    }
  });
};


// Kill child process
Interface.prototype.kill = function() {
  if (!this.child) return;
  this.killChild();
};


// Activate debug repl
Interface.prototype.repl = function() {
  if (!this.requireConnection()) return;

  var self = this;

  self.print('Press Ctrl + C to leave debug repl');

  // Don't display any default messages
  var listeners = this.repl.rli.listeners('SIGINT').slice(0);
  this.repl.rli.removeAllListeners('SIGINT');

  // Exit debug repl on Ctrl + C
  this.repl.rli.once('SIGINT', function() {
    // Restore all listeners
    process.nextTick(function() {
      listeners.forEach(function(listener) {
        self.repl.rli.on('SIGINT', listener);
      });
    });

    // Exit debug repl
    self.exitRepl();
  });

  // Set new
  this.repl.eval = this.debugEval.bind(this);
  this.repl.context = {};

  // Swap history
  this.history.control = this.repl.rli.history;
  this.repl.rli.history = this.history.debug;

  this.repl.prompt = '> ';
  this.repl.rli.setPrompt('> ');
  this.repl.displayPrompt();
};


// Exit debug repl
Interface.prototype.exitRepl = function() {
  // Restore eval
  this.repl.eval = this.controlEval.bind(this);

  // Swap history
  this.history.debug = this.repl.rli.history;
  this.repl.rli.history = this.history.control;

  this.repl.context = this.context;
  this.repl.prompt = 'debug> ';
  this.repl.rli.setPrompt('debug> ');
  this.repl.displayPrompt();
};


// Quit
Interface.prototype.quit = function() {
  this.killChild();
  process.exit(0);
};


// Kills child process
Interface.prototype.killChild = function() {
  if (this.child) {
    this.child.kill();
    this.child = null;
  }

  if (this.client) {
    // Save breakpoints
    this.breakpoints = this.client.breakpoints;

    this.client.destroy();
    this.client = null;
  }
};


// Spawns child process (and restores breakpoints)
Interface.prototype.trySpawn = function(cb) {
  var self = this,
      breakpoints = this.breakpoints || [],
      port = exports.port,
      host = 'localhost',
      childArgs = this.args;

  this.killChild();

  if (this.args.length === 2) {
    var match = this.args[1].match(/^([^:]+):(\d+)$/);

    if (match) {
      // Connecting to remote debugger
      // `node debug localhost:5858`
      host = match[1];
      port = parseInt(match[2], 10);
      this.child = {
        kill: function() {
          // TODO Do we really need to handle it?
        }
      };
    }
  } else if (this.args.length === 3) {
    // `node debug -p pid`
    if (this.args[1] === '-p' && /^\d+$/.test(this.args[2])) {
      this.child = {
        kill: function() {
          // TODO Do we really need to handle it?
        }
      };
      process._debugProcess(parseInt(this.args[2], 10));
    } else {
      var match = this.args[1].match(/^--port=(\d+)$/);
      if (match) {
        // Start debugger on custom port
        // `node debug --port=5858 app.js`
        port = parseInt(match[1], 10);
        childArgs = ['--debug-brk=' + port].concat(this.args.slice(2));
      }
    }
  }

  if (!this.child) {
    this.child = spawn(process.execPath, childArgs);

    this.child.stdout.on('data', this.childPrint.bind(this));
    this.child.stderr.on('data', this.childPrint.bind(this));
  }

  this.pause();

  var client = self.client = new Client(),
      connectionAttempts = 0;

  client.once('ready', function() {
    self.stdout.write(' ok\n');

    // Restore breakpoints
    breakpoints.forEach(function(bp) {
      self.print('Restoring breakpoint ' + bp.scriptReq + ':' + bp.line);
      self.setBreakpoint(bp.scriptReq, bp.line, bp.condition, true);
    });

    client.on('close', function() {
      self.pause();
      self.print('program terminated');
      self.resume();
      self.client = null;
      self.killChild();
    });

    if (cb) cb();
    self.resume();
  });

  client.on('unhandledResponse', function(res) {
    self.pause();
    self.print('\nunhandled res:' + JSON.stringify(res));
    self.resume();
  });

  client.on('break', function(res) {
    self.handleBreak(res.body);
  });

  client.on('exception', function(res) {
    self.handleBreak(res.body);
  });

  client.on('error', connectError);
  function connectError() {
    // If it's failed to connect 4 times then don't catch the next error
    if (connectionAttempts >= 10) {
      client.removeListener('error', connectError);
    }
    setTimeout(attemptConnect, 500);
  }

  function attemptConnect() {
    ++connectionAttempts;
    self.stdout.write('.');
    client.connect(port, host);
  }

  setTimeout(function() {
    self.print('connecting..', true);
    attemptConnect();
  }, 50);
};

module.exports = Interface;
