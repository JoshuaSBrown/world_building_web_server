FROM postgres:17
ARG UID=10001
ARG GID=10001
RUN groupmod -g ${GID} postgres \
 && usermod  -u ${UID} -g ${GID} postgres \
 && chown -R ${UID}:${GID} /var/lib/postgresql /var/run/postgresql
USER ${UID}:${GID}
