define(function (require) {

  var _ = require('lodash');
  var uniqFilters = require('ui/filter_bar/lib/uniqFilters');
  var replaceOrAddJoinSetFilter   = require('ui/kibi/helpers/join_filter_helper/lib/replace_or_add_join_set_filter');
  var getSavedSearchMeta =  require('ui/kibi/helpers/count_helper/lib/get_saved_search_meta');

  return function CountHelperFactory(Private, Promise, timefilter, indexPatterns, savedSearches, savedDashboards) {

    var kibiStateHelper  = Private(require('ui/kibi/helpers/kibi_state_helper'));
    var kibiTimeHelper   = Private(require('ui/kibi/helpers/kibi_time_helper'));
    var joinFilterHelper = Private(require('ui/kibi/helpers/join_filter_helper/join_filter_helper'));
    var urlHelper        = Private(require('ui/kibi/helpers/url_helper'));

    function CountHelper() {
    }

    /*
     * returns a Promise which resolves to count query definition is a form
     * {
     *   query:
     *   indexPatternId:
     * }
     */

    CountHelper.prototype.getCountQueryForDashboardId = function (dashboardId) {
      var self = this;

      return new Promise(function (fulfill, reject) {

        // use find to minimize number of requests
        savedDashboards.find().then(function (dashboardResp) {
          var dashboard = _.find(dashboardResp.hits, function (hit) {
            return hit.id === dashboardId;
          });

          if (dashboard === undefined) {
            return Promise.reject(new Error('Dashboard: [' + dashboardId + '] does not exists'));
          }

          if (!dashboard.id) {
            return Promise.reject(new Error('Dashboard must have an id'));
          }
          if (!dashboard.savedSearchId || dashboard.savedSearchId === '') {
            return Promise.reject(new Error('For computing counts dashboard must have savedSearchId'));
          }

          savedSearches.get(dashboard.savedSearchId).then(function (savedSearch) {

            // now construct the query
            if (joinFilterHelper.isRelationalPanelEnabled() && joinFilterHelper.isSirenJoinPluginInstalled()) {

              joinFilterHelper.getJoinFilter(dashboard.id).then(function (joinFilter) {

                var dashboardIndex = savedSearch.searchSource._state.index;
                var promises = [
                  urlHelper.getQueriesFromDashboardsWithSameIndex(dashboardId, dashboardIndex),
                  urlHelper.getFiltersFromDashboardsWithSameIndex(dashboardId, dashboardIndex)
                ];
                Promise.all(promises).then(function (results) {
                  var queriesFromDashboardsWirhSameIndex = results[0];
                  var filtersFromDashboardsWirhSameIndex = results[1];
                  self.constructCountQuery(
                    dashboard.id,
                    savedSearch,
                    joinFilter,
                    queriesFromDashboardsWirhSameIndex,
                    filtersFromDashboardsWirhSameIndex
                  )
                  .then(function (query) {
                    fulfill({
                      query: query,
                      indexPatternId: savedSearch.searchSource._state.index.id
                    });
                  }).catch(reject);
                }).catch(reject);
              }).catch(function (err) {
                // we could not get joinFilter
                // there could be multiple reasons - most of them is missconfiguration
                // for now let just login the reason
                if (console) {
                  console.log(err);
                }
                self.constructCountQuery(
                  dashboard.id,
                  savedSearch,
                  null
                )
                .then(function (query) {
                  fulfill({
                    query: query,
                    indexPatternId: savedSearch.searchSource._state.index.id
                  });
                });
              });

            } else if (!joinFilterHelper.isRelationalPanelEnabled() && joinFilterHelper.isSirenJoinPluginInstalled()) {
              // get the join filter if present on the dashboard
              // add it only for the dashboard where focus match
              var joinFilter = urlHelper.getJoinFilter();
              self.constructCountQuery(
                dashboard.id,
                savedSearch,
                (joinFilter && joinFilter.join_set.focus === savedSearch.searchSource._state.index.id) ? joinFilter : null
              )
              .then(function (query) {
                fulfill({
                  query: query,
                  indexPatternId: savedSearch.searchSource._state.index.id
                });
              });

            } else if (!joinFilterHelper.isRelationalPanelEnabled() && !joinFilterHelper.isSirenJoinPluginInstalled()) {

              self.constructCountQuery(
                dashboard.id,
                savedSearch,
                null
              )
              .then(function (query) {
                fulfill({
                  query: query,
                  indexPatternId: savedSearch.searchSource._state.index.id
                });
              });

            } else if (joinFilterHelper.isRelationalPanelEnabled() && !joinFilterHelper.isSirenJoinPluginInstalled()) {

              var error = new Error(
                'The SIREn Join plugin is enabled but not installed. ' +
                'Please install the plugin and restart Kibi, ' +
                'or disable the relational panel in Settings -> Advanced -> kibi:relationalPanel'
              );
              reject(error);
            }
          })
          .catch(function (err) {
            reject(err);
          });
        })
        .catch(function (err) {
          reject(err);
        });
      });
    };

    /*
     * The parameter savedSearch should be a reference to a SavedSearch
     * instance, not a SavedSearch id
     */
    CountHelper.prototype.constructCountQuery = function (
      dashboardId, savedSearch, joinSetFilter,
      extraQueries, extraFilters
    ) {
      return new Promise(function (fulfill, reject) {

        var indexPattern = savedSearch.searchSource._state.index;

        var query = {
          size: 0, // we do not need hits just a count
          query: {
            bool: {
              must: {
                match_all: {}
              },
              must_not: [],
              filter: {
                bool: {
                  must: []
                }
              }
            }
          }
        };

        //update the filters
        var filters = kibiStateHelper.getFiltersForDashboardId(dashboardId) || [];


        // if there are any filters in savedSearch add them
        var savedSearchMeta = getSavedSearchMeta(savedSearch);
        if (savedSearchMeta.filter) {
          filters = filters.concat(savedSearchMeta.filter);
        }

        // any extra filters
        if (extraFilters instanceof Array) {
          filters = filters.concat(extraFilters);
        }

        // here we have to make sure that there are no duplicates
        filters = uniqFilters(filters);

        if (filters) {
          _.each(filters, function (filter) {

            if (filter.meta && filter.meta.disabled === true) {
              return;  // this return does not break is like continue
            }

            if (filter.meta && filter.meta.negate === true) {

              if (filter.query) {
                query.query.bool.must_not.push({query: filter.query});
              } else if (filter.dbfilter) {
                query.query.bool.must_not.push({dbfilter: filter.dbfilter});
              } else if (filter.exists) {
                query.query.bool.must_not.push({exists: filter.exists});
              } else if (filter.geo_bounding_box) {
                query.query.bool.must_not.push({geo_bounding_box: filter.geo_bounding_box});
              } else if (filter.missing) {
                query.query.bool.must_not.push({missing: filter.missing});
              } else if (filter.range) {
                query.query.bool.must_not.push({range: filter.range});
              } else if (filter.script) {
                query.query.bool.must_not.push({script: filter.script});
              } else if (filter.join_set) {
                query.query.bool.must_not.push({join_set: filter.join_set});
              } else if (filter.join_sequence) {
                query.query.bool.must_not.push({join_sequence: filter.join_sequence});
              }
            } else {

              if (filter.query && !kibiStateHelper.isAnalyzedWildcardQueryString(filter.query)) {
                // here add only if not "match *" as it would not add anything to the query anyway
                query.query.bool.filter.bool.must.push({query: filter.query});
              } else if (filter.dbfilter) {
                query.query.bool.filter.bool.must.push({dbfilter: filter.dbfilter});
              } else if (filter.exists) {
                query.query.bool.filter.bool.must.push({exists: filter.exists});
              } else if (filter.geo_bounding_box) {
                query.query.bool.filter.bool.must.push({geo_bounding_box: filter.geo_bounding_box});
              } else if (filter.missing) {
                query.query.bool.filter.bool.must.push({missing: filter.missing});
              } else if (filter.range) {
                query.query.bool.filter.bool.must.push({range: filter.range});
              } else if (filter.script) {
                query.query.bool.filter.bool.must.push({script: filter.script});
              } else if (filter.join_set) {
                query.query.bool.filter.bool.must.push({join_set: filter.join_set});
              } else if (filter.join_sequence) {
                query.query.bool.filter.bool.must.push({join_sequence: filter.join_sequence});
              }

            }

          });
        }

        var queries = [];

        // query from kibiState
        var selectedDashboardQuery = kibiStateHelper.getQueryForDashboardId(dashboardId);
        if (selectedDashboardQuery && !kibiStateHelper.isAnalyzedWildcardQueryString(selectedDashboardQuery)) {
          queries.push({
            query: selectedDashboardQuery
          });
        }

        // query from savedSearchMeta
        if (savedSearchMeta.query && !_.isEmpty(savedSearchMeta.query) &&
            !kibiStateHelper.isAnalyzedWildcardQueryString(savedSearchMeta.query)) {
          queries.push({
            query: savedSearchMeta.query
          });
        }

        // any extra queries
        if (extraQueries instanceof Array) {
          _.each(extraQueries, function (q) {
            if (!kibiStateHelper.isAnalyzedWildcardQueryString(q)) {
              queries.push({
                query: q
              });
            }
          });
        }

        queries = uniqFilters(queries);

        _.each(queries, function (q) {
          query.query.bool.filter.bool.must.push(q);
        });

        if (joinSetFilter) {
          replaceOrAddJoinSetFilter(query.query.bool.filter.bool.must, joinSetFilter, true);
        }

        // update time filter
        var timeFilter = timefilter.get(indexPattern);
        if (timeFilter) {

          kibiTimeHelper.updateTimeFilterForDashboard(dashboardId, timeFilter)
          .then(function (updatedTimeFilter) {
            query.query.bool.filter.bool.must.push(updatedTimeFilter);
            fulfill(query);
          }).catch(function (err) {
            reject(err);
          });

        } else {
          fulfill(query);
        }
      });
    };

    return new CountHelper();
  };
});
