/**
 * typed-function
 *
 * Type checking for JavaScript functions
 *
 * https://github.com/josdejong/typed-function
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    // AMD. Register as an anonymous module.
    define([], factory);
  } else if (typeof exports === 'object') {
    // Node. Does not work with strict CommonJS, but
    // only CommonJS-like environments that support module.exports,
    // like Node.
    module.exports = factory();
  } else {
    // Browser globals (root is window)
    root.typed = factory();
  }
}(this, function () {
  'use strict';

  // order types
  // any type ('any') will be ordered last, and object as second last (as other types
  // may be an object as well, like Array)
  function compareTypes(a, b) {
    if (a === 'any') return 1;
    if (b === 'any') return -1;

    if (a === 'Object') return 1;
    if (b === 'Object') return -1;

    return 0;
  }

  /**
   * Merge multiple objects.
   * @param {...Object} args
   */
  function merge (args) {
    var obj = {};

    for (var i = 0; i < arguments.length; i++) {
      var o = arguments[i];
      for (var prop in o) {
        if (o.hasOwnProperty(prop)) {
          obj[prop] = o[prop];
        }
      }
    }

    return obj;
  }

  /**
   * Get a type test function for a specific data type
   * @param {string} type                   A data type like 'number' or 'string'
   * @returns {function(obj: *) : boolean}  Returns a type testing function.
   *                                        Throws an error for an unknown type.
   */
  function getTypeTest(type) {
    var test = typed.types[type];
    if (!test) {
      var matches = Object.keys(typed.types)
          .filter(function (t) {
            return t.toLowerCase() == type.toLowerCase();
          })
          .map(function (t) {
            return '"' + t + '"';
          });

      throw new Error('Unknown type "' + type + '"' +
          (matches.length ? ('. Did you mean ' + matches.join(', or ') + '?') : ''));
    }
    return test;
  }

  /**
   * Collection with function references (local shortcuts to functions)
   * @constructor
   * @param {string} [name='refs']  Optional name for the refs, used to generate
   *                                JavaScript code
   */
  function Refs(name) {
    this.name = name || 'refs';
    this.categories = {};
  }

  /**
   * Add a function reference.
   * @param {function} fn
   * @param {string} [category='fn']    A function category, like 'fn' or 'signature'
   * @returns {string} Returns the function name, for example 'fn0' or 'signature2'
   */
  Refs.prototype.add = function (fn, category) {
    var cat = category || 'fn';
    if (!this.categories[cat]) this.categories[cat] = [];

    var index = this.categories[cat].indexOf(fn);
    if (index == -1) {
      index = this.categories[cat].length;
      this.categories[cat].push(fn);
    }
    
    return cat + index;
  };

  /**
   * Create code lines for all function references
   * @returns {string} Returns the code containing all function references
   */
  Refs.prototype.toCode = function () {
    var code = [];
    var path = this.name + '.categories';
    var categories = this.categories;

    Object.keys(categories).forEach(function (cat) {
      categories[cat].forEach(function (ref, index) {
        code.push('var ' + cat + index + ' = ' + path + '[\'' + cat + '\'][' + index + '];');
      });
    });
    
    return code.join('\n');
  };

  /**
   * A function parameter
   * @param {string | string[] | Param} types    A parameter type like 'string',
   *                                             'number | boolean'
   * @param {boolean} [varArgs=false]            Variable arguments if true
   * @constructor
   */
  function Param(types, varArgs) {
    // parse the types, can be a string with types separated by pipe characters |
    if (typeof types === 'string') {
      this.types = types.split('|').map(function (type) {
        return type.trim();
      });
    }
    else if (Array.isArray(types)) {
      this.types = types;
    }
    else if (types instanceof Param) {
      return types.clone();
    }
    else {
      throw new Error('String or Array expected');
    }

    // parse variable arguments operator (ellipses '...number')
    if (this.types[0] !== undefined && this.types[0].substring(0, 3) == '...') {
      this.types[0] = this.types[0].substring(3) || 'any';
      this.varArgs = true;
    }
    else {
      this.varArgs = varArgs || false;
    }

    // check for any type arguments
    this.anyType = this.types.some(function (type) {
      return type == 'any';
    });
  }

  /**
   * Create a clone of this param
   * @returns {Param} A cloned version of this param
   */
  Param.prototype.clone = function () {
    return new Param(this.types.slice(), this.varArgs);
  };

  /**
   * Return a string representation of this params types, like 'string' or
   * 'number | boolean' or '...number'
   * @returns {string}
   */
  Param.prototype.toString = function () {
    return (this.varArgs ? '...' : '') + this.types.join('|');
  };

  /**
   * A function signature
   * @param {string | string[]} params  Array with the type(s) of each parameter,
   *                                    or a comma separated string with types
   * @param {function} fn               The actual function
   * @constructor
   */
  function Signature(params, fn) {
    if (typeof params === 'string') {
      this.params = (params !== '') ? params.split(',').map(function (types) {
        return new Param(types);
      }) : [];
    }
    else if (Array.isArray(params)) {
      this.params = params.map(function (types) {
        return new Param(types);
      });
    }
    else {
      throw new Error('string or Array expected');
    }
    
    // check variable arguments operator '...'
    var withVarArgs = this.params.filter(function (param) {
      return param.varArgs;
    });
    if (withVarArgs.length === 0) {
      this.varArgs = false;
    }
    else if (withVarArgs[0] === this.params[this.params.length - 1]) {
      this.varArgs = true;
    }
    else {
      throw new SyntaxError('Unexpected variable arguments operator "..."');
    }

    this.fn = fn;
  }

  /**
   * Split params with multiple types in separate signatures,
   * for example split a Signature "string | number" into two signatures.
   * @return {Signature[]} Returns an array with signatures (at least one)
   */
  Signature.prototype.split = function () {
    var signatures = [];

    function _iterate(signature, types, index) {
      if (index < signature.params.length) {
        var param = signature.params[index];
        if (index == signature.params.length - 1 && signature.varArgs) {
          // last parameter of a varArgs signature. Do not split the varArgs parameter
          _iterate(signature, types.concat(param), index + 1);
        }
        else {
          param.types.forEach(function (type) {
            _iterate(signature, types.concat(new Param(type, param.varArgs)), index + 1);
          });
        }
      }
      else {
        signatures.push(new Signature(types, signature.fn));
      }
    }
    _iterate(this, [], 0);

    return signatures;
  };

  /**
   * A node is used to create a node tree to recursively traverse parameters
   * of a function. Nodes have either:
   * - Child nodes in a map `types`.
   * - No child nodes but a function `fn`, the function to be called for 
   *   This signature.
   * @param {Param} type   The parameter type of this node
   * @constructor
   */
  function Node (type) {
    this.type = type;
    this.fn = null;
    this.varArgs = false; // true if variable args '...'
    this.childs = {};
  }

  /**
   * Calculates the maximum depth (level) of nested childs
   * @return {number} Returns the maximum depth (zero if no childs, one if
   *                  it has childs without childs, etc)
   */
  Node.prototype.depth = function () {
    var level = 0;
    Object.keys(this.childs).forEach(function (type) {
      var childLevel = this.childs[type].depth() + 1;
      level = Math.max(level, childLevel);
    }.bind(this));

    return level;
  };

  /**
   * Test recursively whether this Node or any of it's childs need conversions
   */
  Node.prototype.hasConversions = function () {
    if (this._getConversions().length > 0) {
      return true;
    }
    if (this.type && this.type.varArgs && this._getVarArgConversions().length > 0) {
      return true;
    }

    if (this.childs) {
      for (var type in this.childs) {
        if (this.childs.hasOwnProperty(type)) {
          if (this.childs[type].hasConversions()) {
            return true;
          }
        }
      }
    }

    return false;
  };

  /**
   * Returns a string with JavaScript code for this function
   *
   * @param {{refs: Refs, args: string[], types: Param[], tests: string[], prefix: string, conversions: boolean, exceptions: boolean}} params
   * @param {{from: string, to: string, convert: function}} [conversion]
   *
   * Where:
   *   {Refs} refs            Object to store function references
   *   {string[]} args        Argument names, like ['arg0', 'arg1', ...],
   *                          but can also contain conversions like ['arg0', 'convert1(arg1)']
   *   {Param[]} types        Array with parameter types parsed so far
   *   {string[]} tests       Type tests, like ['test0', 'test2', ...]
   *   {string} prefix        A number of spaces to prefix for every line of code
   *   {boolean} conversions  A boolean which is true when the generated
   *                          code must do type conversions
   *   {boolean} exceptions   A boolean which is true when the generated code
   *                          must throw exceptions when there is no signature match
   *
   * @returns {string} code
   *
   * @protected
   */
  Node.prototype._toCode = function (params, conversion) {
    var code = [];

    var prefix = params.prefix;
    var ref = this.fn ? params.refs.add(this.fn, 'signature') : undefined;
    var arg = this.varArgs ? 'varArgs' : ('arg' + params.args.length);
    var type = this.type;

    var test;
    var nextArg;
    var convert;
    if (conversion) {
      test = params.refs.add(getTypeTest(conversion.from), 'test');
      convert = params.refs.add(conversion.convert, 'convert');
      nextArg = (type.varArgs === false) ? (convert + '(' + arg + ')') : arg;
    }
    else {
      test = (type.anyType === false) ? params.refs.add(getTypeTest(type.types[0]), 'test') : '';
      convert = null;
      nextArg = arg;
    }
    var comment = '// type: ' + (convert ? (conversion.from + ', convert to ' + type) : type);

    var args = params.args.concat(nextArg);
    var types = params.types.concat(type);
    var tests = params.tests.concat(test);
    var nextParams = merge(params, {
      args: args,
      types: types,
      tests: tests
    });

    if (this.varArgs) {
      // varArgs cannot have childs, it's the last argument
      if (type.anyType) {
        if (ref) {
          code.push(prefix + 'if (arguments.length >= ' + args.length + ') {');
          code.push(prefix + '  var varArgs = [];');
          code.push(prefix + '  for (var i = ' + (args.length - 1) + '; i < arguments.length; i++) {');
          code.push(prefix + '    varArgs.push(arguments[i]);');
          code.push(prefix + '  }');
          code.push(prefix + '  return ' + ref + '(' + args.join(', ') + '); // signature: ' + types.join(', '));
          code.push(prefix + '}');
          // TODO: throw Exception
        }
      }
      else {
        if (ref) {
          var varTests = type.types.map(function (type) {
                var test = params.refs.add(getTypeTest(type), 'test');
                return test + '(arguments[i])';
              })
              .join(' || ');

          code.push(prefix + 'if (arguments.length >= ' + args.length + ') {');
          code.push(prefix + '  var match = true;');
          code.push(prefix + '  var varArgs = [];');
          code.push(prefix + '  for (var i = ' + (args.length - 1) + '; i < arguments.length; i++) {');
          code.push(prefix + '    if (' + varTests + ') { // type: ' + type.types.join(' or '));
          code.push(prefix + '      varArgs.push(arguments[i]);');

          // iterate over the type conversions
          if (params.conversions) {
            this._getVarArgConversions().forEach(function (conversion) {
              var test = params.refs.add(getTypeTest(conversion.from), 'test');
              var convert = params.refs.add(conversion.convert, 'convert');
              var comment = '// type: ' + conversion.from + ', convert to ' + conversion.to;

              code.push(prefix + '    }');
              code.push(prefix + '    else if (' + test + '(arguments[i])) { ' + comment);
              code.push(prefix + '      varArgs.push(' + convert + '(arguments[i]));');
            }.bind(this));
          }

          code.push(prefix + '    } else {');

          if (params.exceptions) {
            var err = params.refs.add(unexpectedType, 'err');
            code.push(prefix + '      if (i > ' + (args.length - 1) + ') {');
            code.push(prefix + '        throw ' + err + '(\'' + this.type.types + '\', arguments[i], i); // Unexpected type');
            code.push(prefix + '      }');
          }
          code.push(prefix + '      match = false;');
          code.push(prefix + '      break;');

          code.push(prefix + '    }');
          code.push(prefix + '  }');
          code.push(prefix + '  if (match) {');
          code.push(prefix + '    return ' + ref + '(' + args.join(', ') + '); // signature: ' + types.join(', '));
          code.push(prefix + '  }');
          code.push(prefix + '}');
        }
      }
    }
    else {
      if (type.anyType) {
        // any type (ordered last)
        code.push(this._innerCode(nextParams));
      }
      else {
        code.push(prefix + 'if (' + test + '(' + arg + ')) { ' + comment);
        code.push(this._innerCode(merge(nextParams, {prefix: prefix + '  '})));
        code.push(prefix + '}');
      }
    }

    return code.join('\n');
  };

  /**
   * Sub function of Node.prototype._toNode
   *
   * @param {{refs: Refs, args: string[], types: Param[], tests: string[], prefix: string, conversions: boolean, exceptions: boolean}} params
   *
   * Where:
   *   {Refs} refs            Object to store function references
   *   {string[]} args        Argument names, like ['arg0', 'arg1', ...],
   *                          but can also contain conversions like ['arg0', 'convert1(arg1)']
   *                          Must include the arg of the current node.
   *   {Param[]} types        Array with parameter types parsed so far
   *                          Must include the type of the current node.
   *   {string[]} tests       Type tests, like ['test0', 'test2', ...]
   *                          Must include the test of the current node.
   *   {string} prefix        A number of spaces to prefix for every line of code
   *   {boolean} conversions  A boolean which is true when the generated
   *                          code must do type conversions
   *   {boolean} exceptions   A boolean which is true when the generated code
   *                          must throw exceptions when there is no signature match
   *
   * @returns {string} code
   *
   * @protected
   */
  Node.prototype._innerCode = function (params) {
    var code = [];
    var prefix = params.prefix;
    var ref = this.fn ? params.refs.add(this.fn, 'signature') : undefined;

    if (ref) {
      code.push(prefix + 'if (arguments.length === ' + params.args.length + ') {');
      code.push(prefix + '  return ' + ref + '(' + params.args.join(', ') + '); // signature: ' + params.types.join(', '));
      code.push(prefix + '}');
    }

    // iterate over the childs
    this._getChilds().forEach(function (child) {
      code.push(child._toCode(merge(params)));
    });

    // handle conversions
    if (params.conversions) {
      var conversionsCode = this._conversionsToCode(params);
      if (conversionsCode.length > 0) {
        code.push(conversionsCode);
      }
    }

    if (params.exceptions) {
      code.push(this._exceptions(params));
    }

    return code.join('\n');
  };

  /**
   * Create an unsupported type error
   * @param {string} expected    String with comma separated types
   * @param {*} actual           The actual argument
   * @param {number} index       Index of the argument
   * @returns {TypeError} Returns a TypeError
   */
  function unexpectedType (expected, actual, index) {
    var arr = expected.split(',');
    var message = 'Unexpected type of argument';
    var actualType = getTypeOf(actual);
    var err = new TypeError(message + '. Expected: ' + arr.join(' or ') + ', actual: ' + actualType + ', index: ' + index + '.');
    err.data = {
      message: message,
      expected: arr,
      actual: actual,
      index: index
    };
    return err;
  }

  /**
   * Create a too-few-arguments error
   * @param {string} expected    String with comma separated types
   * @param {number} index       index of the argument
   * @returns {TypeError} Returns a TypeError
   */
  function tooFewArguments(expected, index) {
    var arr = expected.split(',');
    var message = 'Too few arguments';
    var err = new TypeError(message + '. Expected: ' + arr.join(' or ') + ', index: ' + index + '.');
    err.data = {
      message: message,
      expected: arr,
      index: index
    };
    return err;
  }

  /**
   * Create an too-many-arguments error
   * @param {number} expected  The expected number of arguments
   * @param {number} actual    The actual number of arguments
   * @returns {TypeError}Returns a TypeError
   */
  function tooManyArguments(expected, actual) {
    var message = 'Too many arguments';
    var err = new TypeError(message + '. Expected: ' + expected + ', actual: ' + actual + '.');
    err.data = {
      message: message,
      expected: expected,
      actual: actual
    };
    return err;
  }
  /**
   * Create code to throw an error
   *
   * @param {{refs: Refs, args: string[], types: Param[], tests: string[], prefix: string, conversions: boolean, exceptions: boolean}} params
   *
   * Where:
   *   {Refs} refs            Object to store function references
   *   {string[]} args        Argument names, like ['arg0', 'arg1', ...],
   *                          but can also contain conversions like ['arg0', 'convert1(arg1)']
   *                          Must include the arg of the current node.
   *   {Param[]} types        Array with parameter types parsed so far
   *                          Must include the type of the current node.
   *   {string[]} tests       Type tests, like ['test0', 'test2', ...]
   *                          Must include the test of the current node.
   *   {string} prefix        A number of spaces to prefix for every line of code
   *   {boolean} conversions  A boolean which is true when the generated
   *                          code must do type conversions
   *   {boolean} exceptions   A boolean which is true when the generated code
   *                          must throw exceptions when there is no signature match
   *
   * @returns {string} Code throwing an error
   *
   * @private
   */
  Node.prototype._exceptions = function (params) {
    var code = [];
    var prefix = params.prefix;
    var argCount = params.args.length;
    var arg = 'arg' + params.args.length;

    var types = Object.keys(this.childs);

    var firstChild = types.length > 0 ? this.childs[types[0]] : undefined;
    if (firstChild && firstChild.varArgs) {
      // TODO: call firstChild._exceptions here?
      var errC = params.refs.add(tooFewArguments, 'err');
      var errD = params.refs.add(unexpectedType, 'err');
      code.push(prefix + 'if (arguments.length === ' + argCount + ') {');
      code.push(prefix + '  throw ' + errC + '(\'' + firstChild.type.types.join(',') + '\', arguments.length); // Too few arguments');
      code.push(prefix + '} else {');
      code.push(prefix + '  throw ' + errD + '(\'' + firstChild.type.types.join(',') + '\', ' + arg + ', ' + argCount + '); // Unexpected type');
      code.push(prefix + '}');
    }
    else {
      if (types.length === 0) {
        code.push(prefix + 'if (arguments.length > ' + argCount + ') {');
        var err = params.refs.add(tooManyArguments, 'err');
        code.push(prefix + '  throw ' + err + '(' + argCount + ', arguments.length); // Too many arguments');
        code.push(prefix + '}');
      }
      else {
        if (types.indexOf('any') === -1) {
          var errA = params.refs.add(tooFewArguments, 'err');
          var errB = params.refs.add(unexpectedType, 'err');
          var typeNames = types.map(function (type) {
            return type.replace(/\.\.\./, '');
          });
          // TODO: add "Actual: ..." to the error message
          code.push(prefix + 'if (arguments.length === ' + argCount + ') {');
          code.push(prefix + '  throw ' + errA + '(\'' + typeNames.join(',') + '\', arguments.length); // Too few arguments');
          code.push(prefix + '}');
          code.push(prefix + 'else {');
          code.push(prefix + '  throw ' + errB + '(\'' + typeNames.join(',') + '\', ' + arg + ', ' + argCount + '); // Unexpected type');
          code.push(prefix + '}');
        }
      }
    }

    return code.join('\n');
  };

  /**
   * Create a code representation for iterating over conversions
   *
   * @param {{refs: Refs, args: string[], types: Param[], tests: string[], prefix: string, conversions: boolean, exceptions: boolean}} params
   *
   * Where:
   *   {Refs} refs            Object to store function references
   *   {string[]} args        Argument names, like ['arg0', 'arg1', ...],
   *                          but can also contain conversions like ['arg0', 'convert1(arg1)']
   *   {Param[]} types        Array with parameter types parsed so far
   *   {string[]} tests       Type tests, like ['test0', 'test2', ...]
   *   {string} prefix        A number of spaces to prefix for every line of code
   *   {boolean} conversions  A boolean which is true when the generated
   *                          code must do type conversions
   *   {boolean} exceptions   A boolean which is true when the generated code
   *                          must throw exceptions when there is no signature match
   *
   * @returns {string} code
   *
   * @protected
   */
  Node.prototype._conversionsToCode = function (params) {
    var code = [];

    // iterate over the type conversions
    this._getConversions().forEach(function (conversion) {
          var type = conversion.to;
          var child = this.childs[type];

          code.push(child._toCode(params, conversion));
        }.bind(this));

    return code.join('\n');
  };

  /**
   * Get the childs of this node ordered by type
   * @return {Node[]} Returns an array with Nodes
   * @protected
   */
  Node.prototype._getChilds = function () {
    return Object.keys(this.childs)
        .sort(compareTypes)
        .map(function (type) {
          return this.childs[type];
        }.bind(this));
  };

  /**
   * Get the conversions relevant for this Node
   * @returns {Array} Array with conversion objects
   * @protected
   */
  Node.prototype._getConversions = function () {
    // if there is a varArgs child, there is no need to do conversions separately,
    // that is handled by the varArg loop
    var hasVarArgs = this._getChilds().some(function (child) {
      return child.type.varArgs;
    });
    if (hasVarArgs) {
      return [];
    }

    // filter the relevant type conversions
    var handled = {};
    return typed.conversions
        .filter(function (conversion) {
          if (this.childs[conversion.from] === undefined &&
              this.childs[conversion.to] !== undefined &&
              !handled[conversion.from]) {
            handled[conversion.from] = true;
            return true;
          }
          else {
            return false;
          }
        }.bind(this));
  };

  /**
   * Get the conversions relevant for a Node with variable arguments
   * @returns {Array} Array with conversion objects
   * @protected
   */
  Node.prototype._getVarArgConversions = function () {
    // filter the relevant type conversions
    var handled = {};
    return typed.conversions
        .filter(function (conversion) {
          if (this.type.types.indexOf(conversion.from) === -1 &&
              this.type.types.indexOf(conversion.to) !== -1 &&
              !handled[conversion.from]) {
            handled[conversion.from] = true;
            return true;
          }
          else {
            return false;
          }
        }.bind(this));
  };

  /**
   * The root node of a node tree
   * @param {string} [name]         Optional function name
   * @constructor
   */
  function RootNode(name) {
    this.name = name || '';
    this.fn = null;
    this.childs = {};
  }

  RootNode.prototype = Object.create(Node.prototype);

  /**
   * Returns a string with JavaScript code for this function
   * @param {Refs} refs     Object to store function references
   * @return {string} code
   */
  RootNode.prototype.toCode = function (refs) {
    var code = [];

    // create an array with all argument names
    var argCount = this.depth();
    var args = [];
    for (var i = 0; i < argCount; i++) {
      args[i] = 'arg' + i;
    }

    // check whether the function at hand needs conversions
    var hasConversions = this.hasConversions();

    // function begin
    code.push('return function ' + this.name + '(' + args.join(', ') + ') {');

    // function signature with zero arguments
    var ref = this.fn ? refs.add(this.fn, 'signature') : undefined;
    if (ref) {
      code.push('  if (arguments.length === 0) {');
      code.push('    return ' + ref + '(); // signature: (empty)');
      code.push('  }');
    }

    var params = {
      refs: refs,
      args: [],
      types: [],
      tests: [],
      prefix: '  '
    };

    if (hasConversions) {
      // create two recursive trees: the first checks exact matches, the second
      // checks all possible conversions. This must be done in two separate
      // loops, else you can get unnecessary conversions.

      // exact matches
      // iterate over the childs
      code.push('  // exactly matching signatures');
      this._getChilds().forEach(function (child) {
        code.push(child._toCode(merge(params, {
          conversions: false,
          exceptions: false
        })));
      });

      // matches and conversions
      code.push('  // convert into matching signatures');
      this._getChilds().forEach(function (child) {
        code.push(child._toCode(merge(params, {
          conversions: true,
          exceptions: true
        })));
      });
      code.push(this._conversionsToCode(merge(params, {
        conversions: true,
        exceptions: true
      })));
    }
    else {
      // no conversions needed for this function. Create one recursive tree to test exact matches
      code.push('  // exactly matching signatures');
      this._getChilds().forEach(function (child) {
        code.push(child._toCode(merge(params, {
          conversions: false,
          exceptions: true
        })));
      });
    }

    // function end
    code.push(this._exceptions(params));
    code.push('}');

    return code.join('\n');
  };

  /**
   * Split all raw signatures into an array with (split) Signatures
   * @param {Object.<string, function>} rawSignatures
   * @return {Signature[]} Returns an array with split signatures
   */
  function parseSignatures(rawSignatures) {
    return Object.keys(rawSignatures).reduce(function (signatures, params) {
      var fn = rawSignatures[params];
      var signature = new Signature(params, fn);

      return signatures.concat(signature.split());
    }, []);
  }

  /**
   * create a map with normalized signatures as key and the function as value
   * @param {Signature[]} signatures   An array with split signatures
   * @return {Object} Returns a map with normalized signatures
   */
  function normalizeSignatures(signatures) {
    var normalized = {};

    signatures.map(function (entry) {
      var signature = entry.params.join(',');
      if (signature in normalized) {
        throw new Error('Error: signature "' + signature + '" defined twice');
      }
      normalized[signature] = entry.fn;
    });

    return normalized;
  }

  /**
   * Parse an object with signatures. Creates a recursive node tree for
   * traversing the number and type of parameters.
   * @param {string} [name]            Function name. Optional
   * @param {Signature[]} signatures   An array with split signatures
   * @return {RootNode}                Returns a node tree
   */
  function parseTree(name, signatures) {
    var root = new RootNode(name);

    signatures.forEach(function (signature) {
      var params = signature.params.concat([]);

      // loop over all parameters, create a nested structure
      var node = root;
      while(params.length > 0) {
        var param = params.shift();
        var type = param.toString();

        var child = node.childs[type];
        if (child === undefined) {
          child = node.childs[type] = new Node(param);
        }
        node = child;
      }

      // add the function as leaf of the innermost node
      node.fn = signature.fn;
      node.varArgs = signature.varArgs;
    });

    return root;
  }

  /**
   * Minify JavaScript code of a typed function
   * @param {string} code
   * @return {string} Returns (roughly) minified code
   */
  function minify (code) {
    return code
        .replace(/\/\/.*/g, '')     // remove comments
        .replace(/\s*\n\s*/gm, '')  // remove spaces and returns

        // remove whitespaces
        .replace(/\s?([{}()=<>;,]+)\s?/g, function (match, delimiter) {
          return delimiter;
        })

        // replace long variable names like 'signature1' with their first letter 's1'
        .replace(/(signature|test|convert|arg)(?=\d)|varArgs|match/g, function (v) {
          // NOTE: all matched variable names must have a unique first letter!!
          return v.charAt(0);
        });
  }

  /**
   * Compose a function from sub-functions each handling a single type signature.
   * Signatures:
   *   typed(signature: string, fn: function)
   *   typed(name: string, signature: string, fn: function)
   *   typed(signatures: Object.<string, function>)
   *   typed(name: string, signatures: Object.<string, function>)
   *
   * @param {string | null} name
   * @param {Object.<string, function>} signatures
   * @return {function} Returns the typed function
   * @private
   */
  function _typed(name, signatures) {
    var refs = new Refs();

    // parse signatures, create a node tree
    var _signatures = parseSignatures(signatures);
    var tree = parseTree(name, _signatures);

    if (_signatures.length == 0) {
      throw new Error('No signatures provided');
    }

    //console.log('TREE\n' + JSON.stringify(tree, null, 2)); // TODO: cleanup
    //console.log('TREE', tree); // TODO: cleanup

    var treeCode = tree.toCode(refs);
    var refsCode = refs.toCode();

    // generate JavaScript code
    var factory = [
      '(function (' + refs.name + ') {',
      refsCode,
      treeCode,
      '})'
    ].join('\n');

    if (typed.config.minify) {
      factory = minify(factory);
    }

    //console.log('CODE\n' + treeCode);  // TODO: cleanup

    // evaluate the JavaScript code and attach function references
    var fn = eval(factory)(refs);

    //console.log('FN\n' + fn.toString()); // TODO: cleanup

    // attach the signatures with sub-functions to the constructed function
    fn.signatures = normalizeSignatures(_signatures); // normalized signatures

    return fn;
  }

  // data type tests
  var types = {
    'null':     function (x) {return x === null},
    'undefined':function (x) {return x === undefined},
    'boolean':  function (x) {return typeof x === 'boolean'},
    'number':   function (x) {return typeof x === 'number'},
    'string':   function (x) {return typeof x === 'string'},
    'function': function (x) {return typeof x === 'function'},
    'Array':    function (x) {return Array.isArray(x)},
    'Date':     function (x) {return x instanceof Date},
    'RegExp':   function (x) {return x instanceof RegExp},
    'Object':   function (x) {return typeof x === 'object'}
  };

  /**
   * Get the type of a value
   * @param {*} x
   * @returns {string} Returns a string with the type of value
   */
  function getTypeOf(x) {
    for (var type in types) {
      if (types.hasOwnProperty(type)) {
        if (types[type](x)) return type;
      }
    }
    return 'unknown';
  }

  // configuration
  var config = {
    minify: true
  };

  // type conversions. Order is important
  var conversions = [];

  // temporary object for holding types and conversions, for constructing
  // the `typed` function itself
  // TODO: find a more elegant solution for this
  var typed = {
    config: config,
    types: types,
    conversions: conversions
  };

  /**
   * Construct the typed function itself with various signatures
   *
   * Signatures:
   *
   *   typed(signature: string, fn: function)
   *   typed(name: string, signature: string, fn: function)
   *   typed(signatures: Object.<string, function>)
   *   typed(name: string, signatures: Object.<string, function>)
   */
  typed = _typed('typed', {
    'Object': function (signatures) {
      return _typed(null, signatures);
    },
    'string, Object': _typed,
    'string, function': function (signature, fn) {
      var signatures = {};
      signatures[signature] = fn;
      return _typed(fn.name || null, signatures);
    },
    'string, string, function': function(name, signature, fn) {
      var signatures = {};
      signatures[signature] = fn;
      return _typed(name, signatures);
    },
    '...function': function (fns) {
      var name = '';
      var signatures = {};
      fns.forEach(function (fn, index) {
        var err;

        // test whether this is a typed-function
        if (!(typeof fn.signatures === 'object')) {
          err = new TypeError('Function is no typed-function (index: ' + index + ')');
          err.data = {index: index};
          throw err;
        }

        // merge the signatures
        for (var signature in fn.signatures) {
          if (fn.signatures.hasOwnProperty(signature)) {
            if (signatures.hasOwnProperty(signature)) {
              err = new Error('Conflicting signatures: "' + signature + '" is defined twice.');
              err.data = {signature: signature};
              throw err;
            }
            else {
              signatures[signature] = fn.signatures[signature];
            }
          }
        }

        // merge function name
        if (fn.name != '') {
          if (name == '') {
            name = fn.name;
          }
          else if (name != fn.name) {
            err = new Error('Function names do not match: "' + name + '" != "' + fn.name + '".');
            err.data = {
              actual: fn.name,
              expected: name
            };
            throw err;
          }
        }
      });

      return _typed(name, signatures);
    }
  });

  //console.log(typed.toString())


  // attach types and conversions to the final `typed` function
  typed.config = config;
  typed.types = types;
  typed.conversions = conversions;

  return typed;
}));

