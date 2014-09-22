var async = require('async'),
    _ = require('lodash'),
    smokesignals = envRequire('smokesignals');

module.exports = function(app, params) {
    var moduleId = params.moduleId,
        timeouts = [], // Массив всех таймаутов для текущей копии модуля
        requests = [], // Массив запросов к апи
        intervals = []; // Массив всех интервалов для текущей копии модуля

    function loadModule(conf) {
        // новый объект необязательно создавать
        // сейчас нет и скорее всего не будет ситуации когда один и тот же конфиг передается на инициализацию разным слотам
        // даже в этом случае использование parentId далее происходит через копирование и опасности никакой нет
        conf.parentId = moduleId;
        return app.loadModule(conf);
    }

    function ensureFunction(f) {
        return _.isFunction(f) ? f : _.noop;
    }

    var slot = {
        STAGE_INITING: 1,
        STAGE_INITED: 2,
        STAGE_KILLED: 4,
        STAGE_DISPOSED: 8,
        STAGE_ALIVE: 3, // = STAGE_INITING | STAGE_INITED
        STAGE_NOT_ALIVE: 12, // = STAGE_DISPOSED | STAGE_KILLED

        stage: 1,

        templates: params.templates,
        modules: {},
        config: app.config,

        addTransition: app.addTransition,
        runInQueue: app.runInQueue,

        /**
         * @deprecated. Use 'init' instead
         */
        initModule: function(moduleConf, callback) {
            return this.init(moduleConf, callback);
        },

        /**
         * Инициализирует модуль
         *
         * @param {string} name - тип модуля, например firmCard
         * @param {object} [data] - данные для инициализации модуля, которые прилетят в инит модуля первым аргументом. Опционально
         * @param {Function} callback - колбек, вызываемый инитом модуля асинхнонно, или враппером синхронно, если модуль синхронный и не имеет колбека в ините. Опционально
         */
        init: function(name, data, callback) {
            // Если слот умер - ничего инитить нет смысла,
            // потому что слот умирает вместе с родительским модулем
            if (slot.stage & slot.STAGE_NOT_ALIVE) return;

            // Старый интерфейс
            if (_.isObject(name)) {
                callback = data;

                var moduleConf = name;

                name = moduleConf.type;
                data = moduleConf.data;
            } else if (_.isFunction(data)) {
                callback = data;
                data = {};
            }

            var module = loadModule({ type: name, data: data });

            module.init(data, function(err) {
                var moduleName = name;

                if (err) {
                    module.dispose();
                } else {
                    var modules = slot.modules[moduleName];

                    // Если модуль такого типа уже есть, то преобразуем в массив
                    if (modules) {
                        if (!_.isArray(modules)) { // Если сейчас только 1 инстанс, и ещё не преобразовано в массив
                            slot.modules[moduleName] = [modules];
                        }

                        slot.modules[moduleName].push(module);
                    } else {
                        slot.modules[moduleName] = module;
                    }
                }

                if (callback) {
                    callback(err, module);
                }
            });

            return module;
        },

        initModules: function(modules, callback) {
            async.map(modules, slot.init, callback);
        },

        initModulesSeries: function(modules, callback) {
            async.mapSeries(modules, slot.init, callback);
        },

        requireComponent: function(name, extraArgs) {
            var component,
                componentMeta = app.loadComponent(name);

            if (componentMeta.emitAbortablesBy) {
                component = app.newComponent(name, extraArgs);
                component.on(componentMeta.emitAbortablesBy, function(req) {
                    requests.push(req);
                });
                component.on('done', function(req) {
                    requests = _.without(requests, req);
                });
            } else {
                component = app.requireComponent(name, extraArgs);
            }
            return component;
        },

        clearRequests: function() {
            _.each(requests, function(req) {
                req.abort();
            });
            requests = [];
        },

        notify: _.partial(ensureFunction(app.notify), moduleId),

        // Рассылаем сообщения всем дочерним, и внучатым модулям :)
        broadcast: _.partial(ensureFunction(app.broadcast), moduleId),

        queryModules: _.partial(ensureFunction(app.queryModules), moduleId),

        block: _.partial(ensureFunction(app.block), moduleId),

        isServer: app.isServer,

        isClient: app.isClient,

        isGrym: app.isGrym,

        domBound: app.isBound,

        /**
         * Отвечает на вопрос нужно ли отрисовывать стэйт в случае инита приложения
         * (когда приложение уже проиничино есс-но вернет true)
         * @returns {boolean}
         */
        needRenderState: app.needRenderState,

        rerender: _.partial(ensureFunction(app.rerender), moduleId),

        rebind: function() {
            if (slot.isClient) {
                app.unbindEvents(moduleId);
                app.bindEvents(moduleId);
            }
        },

        element: _.partial(ensureFunction(app.element), moduleId),

        bindEvents: _.partial(ensureFunction(app.bindEvents), moduleId),

        mod: _.partial(ensureFunction(app.mod), moduleId),

        // Возвращает дочерний модуль по айдишнику
        moduleById: _.partial(ensureFunction(app.getChildModuleWrapperById), moduleId),

        moduleId: function() {
            return moduleId;
        },

        // Выставить таймаут для возможности его автоматической отмены при диспозе.
        setTimeout: function(func, delay) {
            if (slot.stage & slot.STAGE_NOT_ALIVE) return;

            var timer = app.setTimeout(func, delay);

            if (timer) timeouts.push(timer);

            return timer;
        },

        // Отменить все таймауты для данного модуля. Вызывается при диспозе.
        clearTimeouts: function() {
            _.each(timeouts, function(timer) {
                clearTimeout(timer);
            });
        },

        setInterval: function(func, delay) {
            var interval = app.setInterval(func, delay);

            if (interval) intervals.push(interval);

            return interval;
        },

        clearIntervals: function() {
            _.each(intervals, function(interval) {
                clearInterval(interval);
            });
        },

        uniqueId: app.uniqueId,

        registry: app.registry,

        raise: app.raise,

        onTransitionEnd: app.onTransitionEnd,

        closestModule: _.partial(ensureFunction(app.closestModule), moduleId),

        // Регистритует функцию и возвращает триггер на её исполнение, не исполняет если модуль уже убит
        ifAlive: function(fn) {
            return function() {
                if (!(slot.stage & slot.STAGE_NOT_ALIVE)) {
                    fn.apply(this, arguments);
                }
            }
        },

        cookie: app.cookie
    };

    app.setupSlot(slot);

    return slot;
};
