var fs = require('fs');
var Buffer = require('buffer').Buffer;

module.exports = MDDF;

function MDDF (opts) {
    if (!(this instanceof MDDF)) return new MDDF(opts);
    
    this._reader = opts.read;
    this._writer = opts.write;
    
    this.blksize = opts.blksize || 4096;
    this.dim = opts.dim;
    this.B = Math.floor((this.blksize - 4) / (this.dim * 4 + 4));
    this.size = opts.size || 0;
    this.queue = [];
}

MDDF.prototype.put = function (pt, value, cb) {
    var self = this;
    this.queue.push([ pt, value, cb ]);
    if (this.queue.length !== 1) return;
    (function next () {
        var q = self.queue[0];
        self._put(q[0], q[1], function (err) {
            if (cb) cb(err);
            self.queue.shift();
            if (self.queue.length > 0) next();
        });
    })();
};
    
MDDF.prototype._put = function (pt, value, cb) {
    var self = this;
    if (!self._writer) {
        return cb(new Error('cannot put points: no write function defined'));
    }
    if (self.dim !== pt.length) {
        return cb(new Error('inconsistent dimension'));
    }
    
    (function next (index, depth) {
        self._readBlock(index, function (err, buf) {
            if (err) return cb(err);
            var free = self._available(buf);
            var needed = self.dim * 4 + 4 + value.length + 4;
            
            if (free >= needed) {
                // not full, add point
                var ptlen = buf.readUInt32BE(0);
                
                buf.writeUInt32BE(ptlen + 1, 0);
                var offset = 4 + ptlen * (self.dim * 4 + 4);
                for (var i = 0; i < pt.length; i++) {
                    buf.writeFloatBE(pt[i], offset + i*4);
                }
                var dataix = self._putData(buf, value);
                buf.writeUInt32BE(dataix, offset + i*4);
                
                return self._writeBlock(index, buf, cb);
            }
            
            var ix = depth % self.dim;
            var pivot = buf.readFloatBE(4 + ix * 4);
            
            if (pt[ix] < pivot) {
                next(index * 2 + 1, depth + 1);
            }
            else {
                next((index + 1) * 2, depth + 1);
            }
        });
    })(0, 0);
};

MDDF.prototype._putData = function (buf, value) {
    var datalen = buf.readUInt32BE(buf.length - 4);
    var offset = buf.length - 4;
    for (var i = 0; i < datalen; i++) {
        var len = buf.readUInt32BE(offset - 4);
        offset -= len + 4;
    }
    buf.writeUInt32BE(value.length, offset - 4);
    value.copy(buf, offset - value.length - 4, 0, value.length);
    buf.writeUInt32BE(datalen + 1, buf.length - 4);
    return buf.length - offset;
};

MDDF.prototype._available = function (buf) {
    var ptlen = buf.readUInt32BE(0);
    var datalen = buf.readUInt32BE(buf.length - 4);
    
    var free = buf.length - ptlen * (this.dim * 4 + 4) - 8;
    var offset = buf.length - 4;
    for (var i = 0; i < datalen; i++) {
        var len = buf.readUInt32BE(offset - 4);
        offset -= len + 4;
        free -= len + 4;
    }
    return free;
};

MDDF.prototype._readBlock = function (n, cb) {
    var self = this;
    var offset = n * this.blksize;
    if (offset >= this.size) {
        this.size = (n + 1) * this.blksize;
        var buf = Buffer(this.blksize);
        buf.writeUInt32BE(0, 0); // ptlen
        buf.writeUInt32BE(0, buf.length-4); // datalen
        return cb(null, buf);
    }
    var buf = Buffer(this.blksize);
    this._reader(buf, 0, this.blksize, offset, onread);
    
    function onread (err, bytes) {
        if (err) cb(err);
        else if (bytes === this.blksize) {
            cb(null, buf);
        }
        else if (bytes < this.blksize) {
            self._reader(buf, bytes, self.blksize - bytes, offset, onread);
        }
        else {
            cb(null, buf.slice(0, bytes));
        }
    }
};

MDDF.prototype._writeBlock = function (n, buf, cb) {
    this._writer(buf, 0, this.blksize, n * this.blksize, cb);
};

MDDF.prototype.nn = function (pt, cb) {
    var self = this;
    var nearest = null;
    var ndist = null;
    var ndata = null;
    var noffset = null;
    var nbuf = null;
    
    (function next (index, depth) {
        if (index * self.blksize >= self.size) {
            var len = nbuf.readUInt32BE(nbuf.length - noffset - 4);
            var ndata = nbuf.slice(
                nbuf.length - noffset - len - 4,
                nbuf.length - noffset - 4
            );
            return cb(null, nearest, ndata);
        }
        self._readBlock(index, function (err, buf) {
            if (err) return cb(err);
            var len = buf.readUInt32BE(0);
            for (var i = 0; i < len; i++) {
                var ppt = [];
                for (var j = 0; j < self.dim; j++) {
                    ppt.push(buf.readFloatBE(4+i*(self.dim*4+4)+j*4));
                }
                var offset = buf.readUInt32BE(4+i*(self.dim*4+4)+j*4);
                var d = dist(pt, ppt);
                if (nearest === null || d < ndist) {
                    nearest = ppt;
                    ndist = d;
                    noffset = offset;
                    nbuf = buf;
                }
            }
            
            var ix = depth % self.dim;
            var pivot = buf.readFloatBE(4 + ix * 4);
            
            if (pt[ix] < pivot) {
                next(index * 2 + 1, depth + 1);
            }
            else {
                next((index + 1) * 2, depth + 1);
            }
        });
    })(0, 0);
};

function dist (a, b) {
    var sum = 0;
    for (var i = 0; i < a.length; i++) {
        sum += (a[i]-b[i])*(a[i]-b[i]);
    }
    return Math.sqrt(sum);
}
